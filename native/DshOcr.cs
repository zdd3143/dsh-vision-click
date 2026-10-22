// dsh-vision-click :: vision helper
//
// Two things the script side cannot do well on its own:
//
// 1. Windows.Media.Ocr is a WinRT API. PowerShell 5.1 can call it, but its WinRT
//    collection projection (OcrResult.Lines / OcrLine.Words) comes back as an
//    opaque __ComObject that cannot be indexed or cast in script. This helper
//    owns the whole async chain and returns one JSON string.
//
//    JSON: { "lang", "width", "height",
//            "lines": [ { "t", "x", "y", "w", "h", "words": [[t,x,y,w,h], ...] } ] }
//    Coordinates are pixels in the decoded image (top-left origin).
//
// 2. A per-pixel frame diff. Sampling a few points per grid cell in PowerShell
//    misses small changes (a status label), and a full GetPixel loop over
//    4M pixels takes seconds. LockBits + byte math does it in ~40ms and reads
//    every pixel, so "the click did nothing" is a trustworthy verdict.
//
//    JSON: { "ratio", "cellsX", "cellsY", "changed", "totalCells", "maxDelta",
//            "width", "height", "bbox": {x,y,w,h}|null, "cellList": [{x,y,w,h,r}] }
//
// Both are compiled together into native/DshOcr.dll by scripts/build-ocr.ps1.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

public static class DshOcr
{
    /// <summary>Recognize one image file. langTag null/empty means "user profile languages".</summary>
    public static string Recognize(string path, string langTag)
    {
        if (string.IsNullOrEmpty(path)) throw new ArgumentException("path is required");

        byte[] bytes = System.IO.File.ReadAllBytes(path);
        var ras = new InMemoryRandomAccessStream();
        var writer = new DataWriter(ras);
        try
        {
            writer.WriteBytes(bytes);
            writer.StoreAsync().AsTask().GetAwaiter().GetResult();
            writer.DetachStream();
        }
        finally
        {
            writer.Dispose();
        }

        ras.Seek(0);
        var decoder = BitmapDecoder.CreateAsync(ras).AsTask().GetAwaiter().GetResult();
        var bitmap = decoder.GetSoftwareBitmapAsync().AsTask().GetAwaiter().GetResult();

        OcrEngine engine = null;
        if (!string.IsNullOrEmpty(langTag))
        {
            try { engine = OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language(langTag)); }
            catch { engine = null; }
        }
        if (engine == null) engine = OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine == null) throw new InvalidOperationException("no OCR engine installed for this language");

        var result = engine.RecognizeAsync(bitmap).AsTask().GetAwaiter().GetResult();

        var sb = new StringBuilder(4096);
        sb.Append("{\"lang\":\"").Append(Esc(engine.RecognizerLanguage.LanguageTag)).Append("\"");
        sb.Append(",\"width\":").Append(decoder.PixelWidth);
        sb.Append(",\"height\":").Append(decoder.PixelHeight);
        sb.Append(",\"lines\":[");

        bool firstLine = true;
        foreach (OcrLine line in result.Lines)
        {
            var words = new List<OcrWord>(line.Words);
            if (words.Count == 0) continue;

            double x0 = double.MaxValue, y0 = double.MaxValue, x1 = 0, y1 = 0;
            foreach (OcrWord w in words)
            {
                var r = w.BoundingRect;
                if (r.X < x0) x0 = r.X;
                if (r.Y < y0) y0 = r.Y;
                if (r.X + r.Width > x1) x1 = r.X + r.Width;
                if (r.Y + r.Height > y1) y1 = r.Y + r.Height;
            }

            if (!firstLine) sb.Append(',');
            firstLine = false;
            sb.Append("{\"t\":\"").Append(Esc(line.Text)).Append("\"");
            sb.Append(",\"x\":").Append((int)Math.Round(x0));
            sb.Append(",\"y\":").Append((int)Math.Round(y0));
            sb.Append(",\"w\":").Append((int)Math.Round(x1 - x0));
            sb.Append(",\"h\":").Append((int)Math.Round(y1 - y0));
            sb.Append(",\"words\":[");
            bool firstWord = true;
            foreach (OcrWord w in words)
            {
                var r = w.BoundingRect;
                if (!firstWord) sb.Append(',');
                firstWord = false;
                sb.Append("[\"").Append(Esc(w.Text)).Append("\",")
                  .Append((int)Math.Round(r.X)).Append(',')
                  .Append((int)Math.Round(r.Y)).Append(',')
                  .Append((int)Math.Round(r.Width)).Append(',')
                  .Append((int)Math.Round(r.Height)).Append(']');
            }
            sb.Append("]}");
        }

        sb.Append("]}");
        return sb.ToString();
    }

    /// <summary>Comma separated BCP-47 tags of the installed recognizers.</summary>
    public static string Languages()
    {
        var tags = new List<string>();
        foreach (var lang in OcrEngine.AvailableRecognizerLanguages) tags.Add(lang.LanguageTag);
        return string.Join(",", tags.ToArray());
    }

    public static string Version()
    {
        return "dsh-vision/2";
    }

    static string Esc(string s)
    {
        if (s == null) return string.Empty;
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }
}

public static class DshDiff
{
    const double CellThreshold = 0.05;

    public static string Compare(string pathA, string pathB, int cellsX, int cellsY)
    {
        return CompareRegion(pathA, pathB, cellsX, cellsY, 0, 0, 0, 0);
    }

    /// <summary>
    /// Compare two frames, optionally only inside (rx,ry,rw,rh). A local region
    /// around the click is what makes small changes visible: one status label in
    /// a 2560x1600 frame barely moves the global average, but fills a cell of a
    /// 400x400 crop.
    /// </summary>
    public static string CompareRegion(string pathA, string pathB, int cellsX, int cellsY, int rx, int ry, int rw, int rh)
    {
        if (cellsX < 4) cellsX = 4;
        if (cellsY < 4) cellsY = 4;
        if (cellsX > 64) cellsX = 64;
        if (cellsY > 64) cellsY = 64;

        using (var a = new Bitmap(pathA))
        using (var b = new Bitmap(pathB))
        {
            int x0 = 0, y0 = 0;
            int w = Math.Min(a.Width, b.Width);
            int h = Math.Min(a.Height, b.Height);

            if (rw > 0 && rh > 0)
            {
                x0 = Math.Max(0, Math.Min(w - 1, rx));
                y0 = Math.Max(0, Math.Min(h - 1, ry));
                w = Math.Max(1, Math.Min(w - x0, rw));
                h = Math.Max(1, Math.Min(h - y0, rh));
            }

            byte[] bufA = ReadPixels(a, x0, y0, w, h);
            byte[] bufB = ReadPixels(b, x0, y0, w, h);

            int cw = Math.Max(1, w / cellsX);
            int ch = Math.Max(1, h / cellsY);

            var sb = new StringBuilder(2048);
            sb.Append("{\"cellsX\":").Append(cellsX).Append(",\"cellsY\":").Append(cellsY);
            sb.Append(",\"width\":").Append(w).Append(",\"height\":").Append(h);
            sb.Append(",\"offsetX\":").Append(x0).Append(",\"offsetY\":").Append(y0);
            sb.Append(",\"cells\":[");

            double sum = 0;
            double maxDelta = 0;
            int changed = 0;
            int total = 0;
            int minX = w, minY = h, maxX = 0, maxY = 0;
            bool firstCell = true;

            for (int cy = 0; cy < cellsY; cy++)
            {
                for (int cx = 0; cx < cellsX; cx++)
                {
                    int cx0 = cx * cw;
                    int cy0 = cy * ch;
                    int cx1 = Math.Min(w, cx0 + cw);
                    int cy1 = Math.Min(h, cy0 + ch);
                    long diff = 0;
                    long count = 0;

                    for (int y = cy0; y < cy1; y++)
                    {
                        int row = y * w;
                        for (int x = cx0; x < cx1; x++)
                        {
                            int i = (row + x) * 4;
                            diff += Math.Abs(bufA[i] - bufB[i]);
                            diff += Math.Abs(bufA[i + 1] - bufB[i + 1]);
                            diff += Math.Abs(bufA[i + 2] - bufB[i + 2]);
                            count += 3;
                        }
                    }

                    double delta = count > 0 ? diff / (count * 255.0) : 0;
                    sum += delta;
                    total++;
                    if (delta > maxDelta) maxDelta = delta;

                    if (delta > CellThreshold)
                    {
                        changed++;
                        if (cx0 < minX) minX = cx0;
                        if (cy0 < minY) minY = cy0;
                        if (cx1 > maxX) maxX = cx1;
                        if (cy1 > maxY) maxY = cy1;

                        if (!firstCell) sb.Append(',');
                        firstCell = false;
                        sb.Append("{\"x\":").Append(cx0 + x0).Append(",\"y\":").Append(cy0 + y0)
                          .Append(",\"w\":").Append(cx1 - cx0).Append(",\"h\":").Append(cy1 - cy0)
                          .Append(",\"r\":").Append(Math.Round(delta, 3).ToString(CultureInfo.InvariantCulture)).Append('}');
                    }
                }
            }

            sb.Append("],\"ratio\":").Append(Math.Round(total > 0 ? sum / total : 0, 4).ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"changed\":").Append(changed).Append(",\"totalCells\":").Append(total);
            sb.Append(",\"maxDelta\":").Append(Math.Round(maxDelta, 4).ToString(CultureInfo.InvariantCulture));
            if (changed > 0)
            {
                sb.Append(",\"bbox\":{\"x\":").Append(minX + x0).Append(",\"y\":").Append(minY + y0)
                  .Append(",\"w\":").Append(Math.Max(1, maxX - minX)).Append(",\"h\":").Append(Math.Max(1, maxY - minY)).Append('}');
            }
            else
            {
                sb.Append(",\"bbox\":null");
            }
            sb.Append('}');
            return sb.ToString();
        }
    }

    static byte[] ReadPixels(Bitmap source, int x0, int y0, int w, int h)
    {
        using (var copy = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(copy))
            {
                g.DrawImage(source, new Rectangle(0, 0, w, h), new Rectangle(x0, y0, w, h), GraphicsUnit.Pixel);
            }
            var data = copy.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var buffer = new byte[data.Stride * h];
                Marshal.Copy(data.Scan0, buffer, 0, buffer.Length);
                return buffer;
            }
            finally
            {
                copy.UnlockBits(data);
            }
        }
    }
}
