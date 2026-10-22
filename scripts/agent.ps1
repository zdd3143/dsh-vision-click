# dsh-vision-click :: perception + input agent
#
# One long-lived PowerShell process owned by index.js. It is the only thing in
# this plugin that touches pixels or the mouse.
#
# Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
#   -> {"id":7,"op":"click","x":640,"y":420,"button":"left","count":1}
#   <- {"id":7,"ok":true,"result":{...}}
#   <- {"id":7,"ok":false,"error":"..."}
#
# Operations
#   ping                                  liveness + OCR availability
#   cursor                                current cursor position
#   screen    outPath maxWidth            capture; returns native + shown size
#   ocr       path scale lang             OCR a PNG, return line/word boxes
#   click     x y button count mods       move + click
#   move      x y                         hover only
#   diff      a b cellsX cellsY           coarse per-cell difference of two PNGs
#   release                               release every button/modifier
#
# Safety: every command re-checks the stop flag on disk first, so a daemon that
# somehow survived an emergency stop still refuses to inject input.

param(
  [Parameter(Mandatory = $true)][string]$PidFile,
  [Parameter(Mandatory = $true)][string]$StopFile,
  [Parameter(Mandatory = $true)][string]$OcrDll
)

$ErrorActionPreference = 'Stop'

try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class VcInput
{
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    const uint KEYUP = 0x0002;
    const uint UNICODE = 0x0004;

    // Unicode injection: the character is sent literally, so "AbC123" keeps its
    // case, Chinese works, and the keyboard layout / CapsLock state does not
    // matter. This is the same mechanism desktop-control's desktop_type uses.
    public static void TypeChar(char ch)
    {
        INPUT[] pair = new INPUT[2];
        pair[0].type = 1;
        pair[0].u.ki.wVk = 0;
        pair[0].u.ki.wScan = (ushort)ch;
        pair[0].u.ki.dwFlags = UNICODE;
        pair[1].type = 1;
        pair[1].u.ki.wVk = 0;
        pair[1].u.ki.wScan = (ushort)ch;
        pair[1].u.ki.dwFlags = UNICODE | KEYUP;
        SendInput(2, pair, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Key(int vk, bool down)
    {
        keybd_event((byte)vk, 0, down ? 0u : KEYUP, UIntPtr.Zero);
    }

    public static int[] Foreground()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return null;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, (int)pid };
    }

    const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
    const uint WHEEL = 0x0800;
    const uint HWHEEL = 0x1000;

    public static void Init() { try { SetProcessDPIAware(); } catch { } }

    public static int CursorX { get { POINT p; GetCursorPos(out p); return p.X; } }
    public static int CursorY { get { POINT p; GetCursorPos(out p); return p.Y; } }

    public static void Move(int x, int y) { SetCursorPos(x, y); }

    public static void Wheel(int delta, bool horizontal)
    {
        mouse_event(horizontal ? HWHEEL : WHEEL, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
    }

    public static void Button(string name, bool down)
    {
        string b = (name == null ? "left" : name.ToLowerInvariant());
        uint f;
        if (b == "right") f = down ? RIGHTDOWN : RIGHTUP;
        else if (b == "middle") f = down ? MIDDLEDOWN : MIDDLEUP;
        else f = down ? LEFTDOWN : LEFTUP;
        mouse_event(f, 0, 0, 0, UIntPtr.Zero);
    }

    // Nothing may stay pressed after a stop or a crash.
    public static void ReleaseAll()
    {
        Button("left", false);
        Button("right", false);
        Button("middle", false);
        int[] keys = new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
        foreach (int vk in keys) { try { keybd_event((byte)vk, 0, 0x0002, UIntPtr.Zero); } catch { } }
    }
}
'@

[VcInput]::Init()

try { [System.IO.File]::WriteAllText($PidFile, [string]$PID) } catch { }

# ------------------------------------------------------------------ OCR bridge

$script:OcrType = $null
$script:DiffType = $null
$script:OcrError = ''

function Initialize-Native {
  if ($script:OcrType) { return }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    if (-not (Test-Path -LiteralPath $OcrDll)) { throw "DshOcr.dll not found: $OcrDll" }
    $bytes = [System.IO.File]::ReadAllBytes($OcrDll)
    $asm = [System.Reflection.Assembly]::Load($bytes)
    $type = $asm.GetType('DshOcr')
    if (-not $type) { throw 'DshOcr type missing' }
    $script:OcrType = $type
    $script:DiffType = $asm.GetType('DshDiff')
    $script:OcrError = ''
  } catch {
    $script:OcrError = [string]$_.Exception.Message
    $script:OcrType = $null
    $script:DiffType = $null
  }
}

function Get-OcrLanguages {
  Initialize-Native
  if (-not $script:OcrType) { return @() }
  try {
    $raw = $script:OcrType.GetMethod('Languages').Invoke($null, @())
    if (-not $raw) { return @() }
    return @($raw -split ',' | Where-Object { $_ })
  } catch { return @() }
}

function Invoke-Ocr([string]$path, $rect, [double]$scale, [string]$lang) {
  Initialize-Native
  if (-not $script:OcrType) { throw ('ocr_unavailable: ' + $script:OcrError) }

  $full = New-Object System.Drawing.Bitmap $path
  $work = $null
  $big = $null
  $tempPath = $null
  $offsetX = 0
  $offsetY = 0
  $effectiveScale = 1.0
  $imgW = $full.Width
  $imgH = $full.Height

  try {
    $work = $full
    if ($null -ne $rect) {
      $rx = [int]$rect.x
      $ry = [int]$rect.y
      $rw = [int]$rect.w
      $rh = [int]$rect.h
      $rx = [Math]::Max(0, [Math]::Min($full.Width - 1, $rx))
      $ry = [Math]::Max(0, [Math]::Min($full.Height - 1, $ry))
      $rw = [Math]::Max(1, [Math]::Min($full.Width - $rx, $rw))
      $rh = [Math]::Max(1, [Math]::Min($full.Height - $ry, $rh))
      $cropRect = New-Object System.Drawing.Rectangle $rx, $ry, $rw, $rh
      $work = $full.Clone($cropRect, $full.PixelFormat)
      $offsetX = $rx
      $offsetY = $ry
    }

    if ($scale -gt 1.01) {
      $effectiveScale = $scale
      # Windows.Media.Ocr caps image dimensions; stay well inside the limit.
      $maxDim = 9000.0
      if ($work.Width -gt 1 -and ($work.Width * $effectiveScale) -gt $maxDim) { $effectiveScale = $maxDim / $work.Width }
      if ($work.Height -gt 1 -and ($work.Height * $effectiveScale) -gt $maxDim) { $effectiveScale = $maxDim / $work.Height }
    }

    $source = $work
    if ($effectiveScale -gt 1.01) {
      $w = [int][Math]::Round($work.Width * $effectiveScale)
      $h = [int][Math]::Round($work.Height * $effectiveScale)
      $big = New-Object System.Drawing.Bitmap $w, $h
      $g = [System.Drawing.Graphics]::FromImage($big)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($work, 0, 0, $w, $h)
      $g.Dispose()
      $source = $big
    }

    $tempPath = $path + '.ocr.png'
    $source.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $json = $script:OcrType.GetMethod('Recognize').Invoke($null, @($tempPath, $lang))
  } finally {
    if ($big) { $big.Dispose() }
    if ($work -and -not [object]::ReferenceEquals($work, $full)) { $work.Dispose() }
    $full.Dispose()
    if ($tempPath) { try { Remove-Item -LiteralPath $tempPath -Force } catch { } }
  }

  $obj = $json | ConvertFrom-Json
  $div = $effectiveScale
  if ($div -lt 0.999) { $div = 1.0 }

  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $obj.lines) {
    $entry = @{
      text  = [string]$line.t
      x     = [int][Math]::Round($line.x / $div) + $offsetX
      y     = [int][Math]::Round($line.y / $div) + $offsetY
      w     = [int][Math]::Round($line.w / $div)
      h     = [int][Math]::Round($line.h / $div)
      words = @()
    }
    if ($line.words) {
      $ws = @()
      foreach ($word in $line.words) {
        $ws += , @(
          [string]$word[0],
          [int][Math]::Round($word[1] / $div) + $offsetX,
          [int][Math]::Round($word[2] / $div) + $offsetY,
          [int][Math]::Round($word[3] / $div),
          [int][Math]::Round($word[4] / $div)
        )
      }
      $entry.words = $ws
    }
    [void]$lines.Add($entry)
  }

  return @{
    lang   = [string]$obj.lang
    width  = [int]$imgW
    height = [int]$imgH
    scale  = [math]::Round($div, 3)
    rect   = $(if ($offsetX -ne 0 -or $offsetY -ne 0 -or $null -ne $rect) { @{ x = $offsetX; y = $offsetY } } else { $null })
    lines  = $lines.ToArray()
  }
}

# ------------------------------------------------------------------ screen

function Get-Bounds([string]$area) {
  if ($area -eq 'all') { return [System.Windows.Forms.SystemInformation]::VirtualScreen }
  return [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

function Get-Monitors {
  $list = @()
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $list += @{
      device  = $s.DeviceName
      primary = [bool]$s.Primary
      x       = [int]$s.Bounds.X
      y       = [int]$s.Bounds.Y
      width   = [int]$s.Bounds.Width
      height  = [int]$s.Bounds.Height
    }
  }
  return $list
}

function Do-Screen([string]$area, [int]$maxWidth, [string]$outPath) {
  $b = Get-Bounds $area
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
    $g.Dispose()
    # Native pixels are what OCR wants: save them untouched first.
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $shownPath = $outPath
    $shownW = $b.Width
    $shownH = $b.Height
    $scaled = $false

    if ($maxWidth -gt 0 -and $b.Width -gt $maxWidth) {
      $shownW = $maxWidth
      $shownH = [int][Math]::Round($b.Height * ($maxWidth / [double]$b.Width))
      $small = New-Object System.Drawing.Bitmap $shownW, $shownH
      $g2 = [System.Drawing.Graphics]::FromImage($small)
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g2.DrawImage($bmp, 0, 0, $shownW, $shownH)
      $g2.Dispose()
      $shownPath = [System.IO.Path]::ChangeExtension($outPath, '.shown.png')
      $small.Save($shownPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $small.Dispose()
      $scaled = $true
    }

    return @{
      path         = $outPath
      shownPath    = $shownPath
      width        = [int]$b.Width
      height       = [int]$b.Height
      shownWidth   = [int]$shownW
      shownHeight  = [int]$shownH
      scaled       = $scaled
      originX      = [int]$b.X
      originY      = [int]$b.Y
      area         = $(if ($area -eq 'all') { 'all' } else { 'primary' })
      cursorX      = [VcInput]::CursorX
      cursorY      = [VcInput]::CursorY
      monitors     = @(Get-Monitors)
    }
  } finally {
    $bmp.Dispose()
  }
}

# ------------------------------------------------------------------ diff

function Do-Diff([string]$a, [string]$b, [int]$cellsX, [int]$cellsY, $rect = $null) {
  Initialize-Native
  if (-not $script:DiffType) {
    throw ('diff_unavailable: ' + $script:OcrError)
  }
  if ($null -ne $rect) {
    $raw = $script:DiffType.GetMethod('CompareRegion').Invoke($null, @(
      $a, $b, $cellsX, $cellsY,
      [int]$rect.x, [int]$rect.y, [int]$rect.w, [int]$rect.h
    ))
  } else {
    $raw = $script:DiffType.GetMethod('Compare').Invoke($null, @($a, $b, $cellsX, $cellsY))
  }
  $obj = $raw | ConvertFrom-Json
  return @{
    ratio      = [double]$obj.ratio
    cellsX     = [int]$obj.cellsX
    cellsY     = [int]$obj.cellsY
    changed    = [int]$obj.changed
    totalCells = [int]$obj.totalCells
    maxDelta   = [double]$obj.maxDelta
    bbox       = $obj.bbox
    cellList   = @($obj.cells)
    width      = [int]$obj.width
    height     = [int]$obj.height
  }
}

# Foreground window: OCR sees far more when it only has to read one window.
function Get-ForegroundWindow {
  $info = [VcInput]::Foreground()
  if (-not $info) { return $null }
  $title = ''
  $processName = ''
  try {
    $p = Get-Process -Id $info[4] -ErrorAction Stop
    $title = [string]$p.MainWindowTitle
    $processName = [string]$p.ProcessName
  } catch { }
  return @{
    x           = $info[0]
    y           = $info[1]
    w           = $info[2]
    h           = $info[3]
    pid         = $info[4]
    title       = $title
    processName = $processName
  }
}
# ------------------------------------------------------------------ input

function Do-Click([int]$x, [int]$y, [string]$button, [int]$count) {
  [VcInput]::Move($x, $y)
  Start-Sleep -Milliseconds 45
  for ($i = 0; $i -lt [Math]::Max(1, $count); $i++) {
    [VcInput]::Button($button, $true)
    Start-Sleep -Milliseconds 18
    [VcInput]::Button($button, $false)
    if ($i -lt $count - 1) { Start-Sleep -Milliseconds 70 }
  }
  return @{ x = $x; y = $y; button = $button; count = [Math]::Max(1, $count) }
}

# Press, hold for HoldMs, release. Long-press menus / "按住不放" interactions.
function Do-Press([int]$x, [int]$y, [string]$button, [int]$holdMs, [int]$count) {
  [VcInput]::Move($x, $y)
  Start-Sleep -Milliseconds 45
  $times = [Math]::Max(1, $count)
  for ($i = 0; $i -lt $times; $i++) {
    [VcInput]::Button($button, $true)
    Start-Sleep -Milliseconds ([Math]::Max(0, $holdMs))
    [VcInput]::Button($button, $false)
    if ($i -lt $times - 1) { Start-Sleep -Milliseconds 70 }
  }
  return @{ x = $x; y = $y; button = $button; holdMs = $holdMs; count = $times }
}

# Mouse-down, move in small steps, mouse-up. The intermediate moves matter:
# Windows only starts a drag after the pointer has actually travelled.
function Do-Drag([int]$x1, [int]$y1, [int]$x2, [int]$y2, [string]$button, [int]$steps, [int]$stepMs) {
  if ($steps -lt 2) { $steps = 14 }
  if ($steps -gt 120) { $steps = 120 }
  if ($stepMs -lt 0) { $stepMs = 12 }
  if ($stepMs -gt 100) { $stepMs = 100 }

  [VcInput]::Move($x1, $y1)
  Start-Sleep -Milliseconds 70
  [VcInput]::Button($button, $true)
  Start-Sleep -Milliseconds 80
  try {
    for ($i = 1; $i -le $steps; $i++) {
      $nx = [int][Math]::Round($x1 + ($x2 - $x1) * ($i / [double]$steps))
      $ny = [int][Math]::Round($y1 + ($y2 - $y1) * ($i / [double]$steps))
      [VcInput]::Move($nx, $ny)
      Start-Sleep -Milliseconds $stepMs
    }
    # A short pause before the drop gives the target time to accept the hover.
    Start-Sleep -Milliseconds 120
  } finally {
    [VcInput]::Button($button, $false)
  }
  return @{ from = @($x1, $y1); to = @($x2, $y2); button = $button; steps = $steps }
}

function Do-Scroll([int]$x, [int]$y, [string]$direction, [int]$amount, [bool]$horizontal) {
  [VcInput]::Move($x, $y)
  Start-Sleep -Milliseconds 40
  $notches = [Math]::Abs($amount)
  if ($notches -eq 0) { $notches = 3 }
  if ($notches -gt 40) { $notches = 40 }
  $one = 120
  if ($direction -eq 'up' -or $direction -eq 'left') { $one = -120 }
  for ($i = 0; $i -lt $notches; $i++) {
    [VcInput]::Wheel($one, $horizontal)
    Start-Sleep -Milliseconds 30
  }
  return @{ x = $x; y = $y; direction = $direction; notches = $notches; horizontal = $horizontal }
}

# ------------------------------------------------------------------ keyboard

$script:VkMap = @{
  'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'win' = 0x5B;
  'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B;
  'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D;
  'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27;
  'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22;
  'capslock' = 0x14; 'printscreen' = 0x2C; 'pause' = 0x13;
  'comma' = 0xBC; 'period' = 0xBE; 'slash' = 0xBF; 'semicolon' = 0xBA;
  'minus' = 0xBD; 'equals' = 0xBB; 'plus' = 0xBB;
}

function Get-Vk([string]$name) {
  $k = $name.Trim().ToLowerInvariant()
  if ($k -eq '') { throw 'empty key name' }
  if ($script:VkMap.ContainsKey($k)) { return [int]$script:VkMap[$k] }
  if ($k -match '^f([1-9]|1[0-2])$') { return 0x70 + ([int]$Matches[1] - 1) }
  if ($k.Length -eq 1) {
    $c = [char]$k[0]
    if ($c -ge 'a' -and $c -le 'z') { return 0x41 + ([int]$c - [int][char]'a') }
    if ($c -ge '0' -and $c -le '9') { return 0x30 + ([int]$c - [int][char]'0') }
  }
  throw "unknown key: $name"
}

function Do-Type([string]$text, [int]$delayMs) {
  if ($null -eq $text) { $text = '' }
  if ($delayMs -lt 0) { $delayMs = 8 }
  $typed = 0
  foreach ($ch in $text.ToCharArray()) {
    if ((Test-Stopped)) { throw 'emergency_stop_active: user pressed the stop hotkey; input is locked' }
    [VcInput]::TypeChar($ch)
    $typed++
    if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
  }
  return @{ chars = $typed }
}

# One combo like "ctrl+shift+s", "enter", "shift+a", "capslock".
function Do-Key([string]$keys, [int]$count) {
  $parts = @($keys -split '\+' | Where-Object { $_ -ne '' })
  if ($parts.Count -eq 0) { throw 'empty key combo' }
  $vks = @()
  foreach ($p in $parts) { $vks += (Get-Vk $p) }
  $times = [Math]::Max(1, $count)
  for ($i = 0; $i -lt $times; $i++) {
    foreach ($vk in $vks) {
      [VcInput]::Key([int]$vk, $true)
      Start-Sleep -Milliseconds 15
    }
    for ($j = $vks.Count - 1; $j -ge 0; $j--) {
      [VcInput]::Key([int]$vks[$j], $false)
      Start-Sleep -Milliseconds 15
    }
    if ($i -lt $times - 1) { Start-Sleep -Milliseconds 60 }
  }
  return @{ parts = $parts; count = $times; vks = $vks }
}

function Test-Stopped {
  return (Test-Path -LiteralPath $StopFile)
}# ------------------------------------------------------------------ main loop

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }

  $id = 0
  try {
    $cmd = $line | ConvertFrom-Json
    $id = [int]$cmd.id
    $op = [string]$cmd.op

    if ((Test-Stopped) -and $op -ne 'ping' -and $op -ne 'cursor') {
      throw 'emergency_stop_active: user pressed the stop hotkey; input is locked'
    }

    switch ($op) {
      'ping' {
        $langs = @(Get-OcrLanguages)
        $result = @{
          pong = $true
          pid = $PID
          ocr = [bool]($script:OcrType)
          ocrError = [string]$script:OcrError
          languages = $langs
        }
      }
      'cursor' { $result = @{ x = [VcInput]::CursorX; y = [VcInput]::CursorY } }
      'screen' { $result = Do-Screen ([string]$cmd.area) ([int]$cmd.maxWidth) ([string]$cmd.outPath) }
      'ocr' { $result = Invoke-Ocr ([string]$cmd.path) $cmd.rect ([double]$cmd.scale) ([string]$cmd.lang) }
      'window' { $result = Get-ForegroundWindow }
      'diff' { $result = Do-Diff ([string]$cmd.a) ([string]$cmd.b) ([int]$cmd.cellsX) ([int]$cmd.cellsY) $cmd.rect }
      'move' {
        [VcInput]::Move([int]$cmd.x, [int]$cmd.y)
        $result = @{ x = [int]$cmd.x; y = [int]$cmd.y }
      }
      'click' { $result = Do-Click ([int]$cmd.x) ([int]$cmd.y) ([string]$cmd.button) ([int]$cmd.count) }
      'press' { $result = Do-Press ([int]$cmd.x) ([int]$cmd.y) ([string]$cmd.button) ([int]$cmd.holdMs) ([int]$cmd.count) }
      'drag' {
        $result = Do-Drag ([int]$cmd.x1) ([int]$cmd.y1) ([int]$cmd.x2) ([int]$cmd.y2) ([string]$cmd.button) ([int]$cmd.steps) ([int]$cmd.stepMs)
      }
      'scroll' {
        $result = Do-Scroll ([int]$cmd.x) ([int]$cmd.y) ([string]$cmd.direction) ([int]$cmd.amount) ([bool]$cmd.horizontal)
      }
      'release' { [VcInput]::ReleaseAll(); $result = @{ released = $true } }
      'type' {
        $result = Do-Type ([string]$cmd.text) ([int]$cmd.delayMs)
        if ($cmd.pressEnter -eq $true) {
          Start-Sleep -Milliseconds 80
          [void](Do-Key 'enter' 1)
          $result.pressEnter = $true
        }
      }
      'key' { $result = Do-Key ([string]$cmd.keys) ([int]$cmd.count) }
      default { throw "unknown op: $op" }
    }

    $reply = @{ id = $id; ok = $true; result = $result }
  } catch {
    $reply = @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
  }

  try {
    [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 10))
    [Console]::Out.Flush()
  } catch { }

  if ($reply.ok -ne $true -and ([string]$reply.error) -like 'emergency_stop_active*') { break }
}
