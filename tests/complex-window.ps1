# dsh-vision-click :: complex task fixture (for the vision on/off comparison)
#
# Deliberately contains controls that are hard for OCR but easy for a vision
# model, plus ordinary ones so both paths get exercised:
#   * a gear icon drawn on a canvas  -> no text at all, OCR cannot see it
#   * a small low-contrast label     -> OCR often misses it, eyes still can
#   * draggable block + drop zone    -> drag
#   * a 40-row list                  -> scroll, then click a row
#   * a submit button                -> plain text, OCR handles it
#
# Every interaction updates the status line, so a test can assert on text.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/complex-window.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CxFg { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = '复杂任务测试窗口'
$form.ClientSize = New-Object System.Drawing.Size 900, 640
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point 60, 60
$form.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 253)
$form.TopMost = $true

function New-UiFont([float]$size, [System.Drawing.FontStyle]$style) {
  return [System.Drawing.Font]::new('Microsoft YaHei UI', $size, $style)
}

$status = New-Object System.Windows.Forms.Label
$status.Text = '状态：等待操作'
$status.Font = New-UiFont 15 ([System.Drawing.FontStyle]::Regular)
$status.ForeColor = [System.Drawing.Color]::FromArgb(0, 110, 90)
$status.AutoSize = $true
$status.Location = New-Object System.Drawing.Point 30, 24
$form.Controls.Add($status)

function Set-Status([string]$text) {
  $script:status.Text = $text
  $script:form.Refresh()
}

# --- canvas gear icon: no text whatsoever ------------------------------------
$gear = New-Object System.Windows.Forms.Panel
$gear.Size = New-Object System.Drawing.Size 110, 110
$gear.Location = New-Object System.Drawing.Point 750, 20
$gear.BackColor = [System.Drawing.Color]::FromArgb(232, 238, 248)
$gear.Cursor = [System.Windows.Forms.Cursors]::Hand
$gear.Add_Paint({
    param($sender, $e)
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(40, 70, 140))
    $cx = 55; $cy = 55; $r = 26
    $g.FillEllipse($brush, ($cx - $r), ($cy - $r), (2 * $r), (2 * $r))
    for ($i = 0; $i -lt 8; $i++) {
      $g.TranslateTransform($cx, $cy)
      $g.RotateTransform(45 * $i)
      $g.FillRectangle($brush, -6, -42, 12, 24)
      $g.ResetTransform()
    }
    $hole = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(232, 238, 248))
    $g.FillEllipse($hole, ($cx - 9), ($cy - 9), 18, 18)
    $brush.Dispose(); $hole.Dispose()
  })
$gear.Add_MouseClick({ Set-Status '状态：点了齿轮图标' })
$form.Controls.Add($gear)

# --- small, low-contrast label ----------------------------------------------
$faint = New-Object System.Windows.Forms.Label
$faint.Text = '低对比度目标'
$faint.Font = New-UiFont 9 ([System.Drawing.FontStyle]::Regular)
$faint.ForeColor = [System.Drawing.Color]::FromArgb(168, 173, 183)
$faint.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 253)
$faint.AutoSize = $true
$faint.Cursor = [System.Windows.Forms.Cursors]::Hand
$faint.Location = New-Object System.Drawing.Point 640, 150
$faint.Add_Click({ Set-Status '状态：点了低对比度文字' })
$form.Controls.Add($faint)

# --- draggable block + drop zone --------------------------------------------
$script:dragging = $false
$script:grabX = 0
$script:grabY = 0

$drag = New-Object System.Windows.Forms.Label
$drag.Text = '拖动我'
$drag.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$drag.Font = New-UiFont 14 ([System.Drawing.FontStyle]::Bold)
$drag.BackColor = [System.Drawing.Color]::FromArgb(255, 214, 102)
$drag.ForeColor = [System.Drawing.Color]::FromArgb(30, 24, 10)
$drag.Size = New-Object System.Drawing.Size 140, 54
$drag.Location = New-Object System.Drawing.Point 40, 120
$drag.Add_MouseDown({
    $script:dragging = $true
    $script:grabX = $_.X
    $script:grabY = $_.Y
  })
$drag.Add_MouseMove({
    if ($script:dragging) {
      $p = $script:form.PointToClient([System.Windows.Forms.Cursor]::Position)
      $script:drag.Left = $p.X - $script:grabX
      $script:drag.Top = $p.Y - $script:grabY
    }
  })
$drag.Add_MouseUp({
    $script:dragging = $false
    Set-Status ("状态：已拖动到 {0},{1}" -f $script:drag.Left, $script:drag.Top)
  })
$form.Controls.Add($drag)

$drop = New-Object System.Windows.Forms.Label
$drop.Text = '目标区'
$drop.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$drop.Font = New-UiFont 13 ([System.Drawing.FontStyle]::Regular)
$drop.BackColor = [System.Drawing.Color]::FromArgb(226, 236, 250)
$drop.ForeColor = [System.Drawing.Color]::FromArgb(20, 40, 70)
$drop.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$drop.Size = New-Object System.Drawing.Size 150, 54
$drop.Location = New-Object System.Drawing.Point 320, 120
$form.Controls.Add($drop)

# --- long list ---------------------------------------------------------------
$list = New-Object System.Windows.Forms.ListBox
$list.Font = New-UiFont 12 ([System.Drawing.FontStyle]::Regular)
$list.Size = New-Object System.Drawing.Size 240, 260
$list.Location = New-Object System.Drawing.Point 620, 260
for ($i = 1; $i -le 40; $i++) { [void]$list.Items.Add(('列表第 {0} 行' -f $i)) }
$list.Add_SelectedIndexChanged({
    Set-Status ("状态：选中第 {0} 行" -f ($script:list.SelectedIndex + 1))
  })
$form.Controls.Add($list)

# --- submit ------------------------------------------------------------------
$submit = New-Object System.Windows.Forms.Button
$submit.Text = '提交'
$submit.Font = New-UiFont 15 ([System.Drawing.FontStyle]::Bold)
$submit.Size = New-Object System.Drawing.Size 160, 54
$submit.Location = New-Object System.Drawing.Point 60, 420
$submit.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$submit.BackColor = [System.Drawing.Color]::FromArgb(240, 244, 252)
$submit.ForeColor = [System.Drawing.Color]::FromArgb(14, 20, 32)
$submit.Add_Click({ Set-Status '状态：已提交' })
$form.Controls.Add($submit)

$reset = New-Object System.Windows.Forms.Button
$reset.Text = '重置'
$reset.Font = New-UiFont 13 ([System.Drawing.FontStyle]::Regular)
$reset.Size = New-Object System.Drawing.Size 120, 44
$reset.Location = New-Object System.Drawing.Point 260, 424
$reset.Add_Click({
    $script:drag.Left = 40
    $script:drag.Top = 120
    $script:list.ClearSelected()
    Set-Status '状态：已重置'
  })
$form.Controls.Add($reset)

$note = New-Object System.Windows.Forms.Label
$note.Text = '齿轮图标没有文字；低对比度文字很小；列表有 40 行，需要滚动'
$note.Font = New-UiFont 10 ([System.Drawing.FontStyle]::Regular)
$note.ForeColor = [System.Drawing.Color]::FromArgb(110, 120, 135)
$note.AutoSize = $true
$note.Location = New-Object System.Drawing.Point 30, 580
$form.Controls.Add($note)

$script:ticks = 0
$keep = New-Object System.Windows.Forms.Timer
$keep.Interval = 500
$keep.Add_Tick({
    $script:ticks += 1
    if ($script:ticks -gt 1200) { $script:keep.Stop(); return }
    try { [void][CxFg]::SetForegroundWindow($script:form.Handle) } catch { }
  })

$form.Add_Shown({
    $form.Activate()
    $keep.Start()
  })
[void]$form.ShowDialog()
