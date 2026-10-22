# dsh-vision-click :: manual test target
#
# A plain WinForms window that exercises every pointer primitive the plugin
# supports, without touching the user's real apps:
#   * three big buttons          -> left click / hover / long press
#   * a movable label            -> real drag (MouseDown/Move/Up, like a file drag)
#   * a list box with 40 rows    -> vertical wheel scroll
# Every interaction changes visible text, so the plugin's verifier has
# something observable to report.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/target-window.ps1
#
# Close the window to stop it.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = '视觉点击测试窗口'
$form.ClientSize = New-Object System.Drawing.Size 780, 540
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point 80, 80
$form.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 253)
$form.TopMost = $true

function New-UiFont([float]$size, [System.Drawing.FontStyle]$style) {
  return [System.Drawing.Font]::new('Microsoft YaHei UI', $size, $style)
}

$title = New-Object System.Windows.Forms.Label
$title.Text = '只靠鼠标点击完成任务'
$title.Font = New-UiFont 18 ([System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(18, 24, 36)
$title.BackColor = [System.Drawing.Color]::Transparent
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point 28, 18
$form.Controls.Add($title)

$status = New-Object System.Windows.Forms.Label
$status.Text = '状态：等待点击'
$status.Font = New-UiFont 15 ([System.Drawing.FontStyle]::Regular)
$status.ForeColor = [System.Drawing.Color]::FromArgb(0, 110, 90)
$status.BackColor = [System.Drawing.Color]::Transparent
$status.AutoSize = $true
$status.Location = New-Object System.Drawing.Point 28, 70
$form.Controls.Add($status)

$script:counter = 0
function Set-Status([string]$text) {
  $script:status.Text = $text
  $script:form.Refresh()
}

# Explicit colors: the system dark theme renders default WinForms buttons as
# grey-on-grey, which OCR cannot read reliably.
function Style-Button($button) {
  $button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $button.BackColor = [System.Drawing.Color]::FromArgb(240, 244, 252)
  $button.ForeColor = [System.Drawing.Color]::FromArgb(14, 20, 32)
  $button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(96, 136, 226)
  $button.FlatAppearance.BorderSize = 2
  $button.UseVisualStyleBackColor = $false
}

$start = New-Object System.Windows.Forms.Button
$start.Text = '开始测试'
$start.Font = New-UiFont 16 ([System.Drawing.FontStyle]::Bold)
$start.Size = New-Object System.Drawing.Size 170, 58
$start.Location = New-Object System.Drawing.Point 28, 120
$start.Add_Click({
    $script:counter += 1
    Set-Status ("状态：已开始第 {0} 次" -f $script:counter)
  })
Style-Button $start
$form.Controls.Add($start)

$prev = New-Object System.Windows.Forms.Button
$prev.Text = '上一步'
$prev.Font = New-UiFont 16 ([System.Drawing.FontStyle]::Regular)
$prev.Size = New-Object System.Drawing.Size 140, 58
$prev.Location = New-Object System.Drawing.Point 220, 120
$prev.Add_Click({ Set-Status '状态：回到上一步' })
Style-Button $prev
$form.Controls.Add($prev)

$next = New-Object System.Windows.Forms.Button
$next.Text = '下一步'
$next.Font = New-UiFont 16 ([System.Drawing.FontStyle]::Regular)
$next.Size = New-Object System.Drawing.Size 140, 58
$next.Location = New-Object System.Drawing.Point 380, 120
$next.Add_Click({ Set-Status '状态：走到下一步' })
Style-Button $next
$form.Controls.Add($next)

# --- draggable label ---------------------------------------------------------
$script:dragging = $false
$script:grabX = 0
$script:grabY = 0

$drag = New-Object System.Windows.Forms.Label
$drag.Text = '拖动我'
$drag.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$drag.Font = New-UiFont 15 ([System.Drawing.FontStyle]::Bold)
$drag.BackColor = [System.Drawing.Color]::FromArgb(255, 214, 102)
$drag.ForeColor = [System.Drawing.Color]::FromArgb(30, 24, 10)
$drag.Size = New-Object System.Drawing.Size 150, 56
$drag.Location = New-Object System.Drawing.Point 40, 400
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
    # Snap home shortly after, so the test can be run again and again.
    $script:resetTimer = New-Object System.Windows.Forms.Timer
    $script:resetTimer.Interval = 1400
    $script:resetTimer.Add_Tick({
        $script:resetTimer.Stop()
        $script:drag.Left = 40
        $script:drag.Top = 400
      })
    $script:resetTimer.Start()
  })
$form.Controls.Add($drag)

$drop = New-Object System.Windows.Forms.Label
$drop.Text = '拖到这里'
$drop.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$drop.Font = New-UiFont 14 ([System.Drawing.FontStyle]::Regular)
$drop.BackColor = [System.Drawing.Color]::FromArgb(226, 236, 250)
$drop.ForeColor = [System.Drawing.Color]::FromArgb(20, 40, 70)
$drop.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$drop.Size = New-Object System.Drawing.Size 170, 56
$drop.Location = New-Object System.Drawing.Point 560, 400
$form.Controls.Add($drop)

# --- scrollable list ---------------------------------------------------------
$list = New-Object System.Windows.Forms.ListBox
$list.Font = New-UiFont 13 ([System.Drawing.FontStyle]::Regular)
$list.Size = New-Object System.Drawing.Size 240, 210
$list.Location = New-Object System.Drawing.Point 520, 100
for ($i = 1; $i -le 40; $i++) {
  [void]$list.Items.Add(('列表第 {0} 行' -f $i))
}
$form.Controls.Add($list)

# --- text field (keyboard test) ---------------------------------------------
$edit = New-Object System.Windows.Forms.TextBox
$edit.Text = '账号'
$edit.Font = New-UiFont 15 ([System.Drawing.FontStyle]::Regular)
$edit.Size = New-Object System.Drawing.Size 360, 42
$edit.Location = New-Object System.Drawing.Point 60, 245
$edit.Add_TextChanged({
    Set-Status ("状态：输入框里有 {0} 个字" -f $script:edit.Text.Length)
  })
$form.Controls.Add($edit)

# --- duplicate labels (ambiguity test) --------------------------------------
# Two identical labels exist so the plugin has a case where it must refuse to
# guess. Nothing happens when they are clicked; the point is that no click is
# allowed at all.
foreach ($dupX in @(60, 320)) {
  $dup = New-Object System.Windows.Forms.Label
  $dup.Text = '重复标签'
  $dup.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
  $dup.Font = New-UiFont 14 ([System.Drawing.FontStyle]::Regular)
  $dup.BackColor = [System.Drawing.Color]::FromArgb(226, 232, 242)
  $dup.ForeColor = [System.Drawing.Color]::FromArgb(30, 40, 55)
  $dup.Size = New-Object System.Drawing.Size 160, 44
  $dup.Location = New-Object System.Drawing.Point $dupX, 330
  $form.Controls.Add($dup)
}

$note = New-Object System.Windows.Forms.Label
$note.Text = '点按钮 / 拖黄色方块 / 在列表上滚轮 / 在输入框里打字，都会改变上面的状态文字'
$note.Font = New-UiFont 11 ([System.Drawing.FontStyle]::Regular)
$note.ForeColor = [System.Drawing.Color]::FromArgb(90, 100, 120)
$note.BackColor = [System.Drawing.Color]::Transparent
$note.AutoSize = $true
$note.Location = New-Object System.Drawing.Point 30, 500
$form.Controls.Add($note)

# Keep this window in the foreground for the first ~90 seconds (one test run).
# Without it the harness window can still be "the active window", and OCR would
# then read the harness transcript instead of this fixture.
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class VcForeground { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'

$script:ticks = 0
$keep = New-Object System.Windows.Forms.Timer
$keep.Interval = 500
$keep.Add_Tick({
    $script:ticks += 1
    if ($script:ticks -gt 180) { $script:keep.Stop(); return }
    try { [void][VcForeground]::SetForegroundWindow($script:form.Handle) } catch { }
  })

$form.Add_Shown({
    $form.Activate()
    $keep.Start()
  })
[void]$form.ShowDialog()
