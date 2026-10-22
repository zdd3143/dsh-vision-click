# dsh-vision-click :: emergency stop watchdog
#
# Deliberately a SEPARATE process from the input daemon. It only watches the
# keyboard and, the moment every key of the stop combo is held (default F6+F7):
#
#   1. writes the stop flag file        (durable evidence; blocks new input)
#   2. kills the daemon by pid          (nothing in flight can continue)
#   3. releases every mouse button and modifier (no stuck drag / held Ctrl)
#   4. prints one line on stdout        (index.js cancels the running turn)
#
# It never restarts anything and never injects input except those releases.

param(
  [Parameter(Mandatory = $true)][string]$StopFile,
  [Parameter(Mandatory = $true)][string]$DaemonPidFile,
  [string]$Hotkey = 'F6+F7',
  [int]$PollMs = 40,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class VcWatch
{
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public static void ReleaseAll()
    {
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero);
        mouse_event(0x0040, 0, 0, 0, UIntPtr.Zero);
        int[] keys = new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
        foreach (int vk in keys) { try { keybd_event((byte)vk, 0, 0x0002, UIntPtr.Zero); } catch { } }
    }
}
'@

try { [void][VcWatch]::SetProcessDPIAware() } catch { }

function Get-Vk([string]$name) {
  $k = $name.Trim().ToLowerInvariant()
  if ($k -match '^f([1-9]|1[0-2])$') { return 0x70 + ([int]$Matches[1] - 1) }
  $map = @{ 'ctrl' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'space' = 0x20; 'esc' = 0x1B }
  if ($map.ContainsKey($k)) { return [int]$map[$k] }
  throw "unsupported hotkey key: $name"
}

$vks = @()
foreach ($part in ($Hotkey -split '\+' | Where-Object { $_ -ne '' })) { $vks += (Get-Vk $part) }
if ($vks.Count -lt 2) { throw "emergencyHotkey must combine at least two keys, got: $Hotkey" }
if ($PollMs -lt 10) { $PollMs = 10 }
if ($PollMs -gt 500) { $PollMs = 500 }

$latched = $false
$lastNotice = 0
$lastParentCheck = 0

while ($true) {
  $all = $true
  foreach ($vk in $vks) {
    if ((([VcWatch]::GetAsyncKeyState($vk)) -band 0x8000) -eq 0) { $all = $false; break }
  }

  if ($all -and -not $latched) {
    $latched = $true

    $payload = @{
      at     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      hotkey = $Hotkey
      pid    = $PID
    } | ConvertTo-Json -Compress
    try { [System.IO.File]::WriteAllText($StopFile, $payload) } catch { }

    try {
      if (Test-Path -LiteralPath $DaemonPidFile) {
        $raw = ([System.IO.File]::ReadAllText($DaemonPidFile)).Trim()
        $dp = 0
        if ([int]::TryParse($raw, [ref]$dp) -and $dp -gt 0 -and $dp -ne $PID) {
          Stop-Process -Id $dp -Force -ErrorAction SilentlyContinue
        }
      }
    } catch { }

    try { [VcWatch]::ReleaseAll() } catch { }

    try {
      [Console]::Out.WriteLine('{"event":"emergency_stop"}')
      [Console]::Out.Flush()
    } catch { }
  }

  if (-not $all) { $latched = $false }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($now - $lastNotice -gt 60000) {
    $lastNotice = $now
    try { [Console]::Out.WriteLine('{"event":"heartbeat"}'); [Console]::Out.Flush() } catch { }
  }

  # Orphan guard: if the host process died, never keep a global keyboard poller
  # alive (it would also keep inherited stdout pipes open and hang the caller).
  if ($ParentPid -gt 0 -and ($now - $lastParentCheck) -gt 2000) {
    $lastParentCheck = $now
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  }

  Start-Sleep -Milliseconds $PollMs
}
