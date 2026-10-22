# dsh-vision-click :: build the OCR helper
#
# Compiles native/DshOcr.cs into native/DshOcr.dll with the .NET Framework csc.
# The DLL only wraps Windows.Media.Ocr; it is loaded at runtime via
# Assembly.Load(bytes), never referenced by path.
#
# Run this once after cloning, or whenever DshOcr.cs changes:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-ocr.ps1
#
# Output: native/DshOcr.dll (next to native/DshOcr.cs)

param(
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgDir = Split-Path -Parent $scriptDir
if (-not $OutDir) { $OutDir = Join-Path $pkgDir 'native' }
$src = Join-Path $OutDir 'DshOcr.cs'
$dll = Join-Path $OutDir 'DshOcr.dll'

if (-not (Test-Path -LiteralPath $src)) { throw "source not found: $src" }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found: $csc" }

# The union metadata aggregates every WinRT namespace, which is exactly what we
# need to reference Windows.Foundation / Storage / Graphics / Media / Globalization
# without hitting duplicate-type errors from per-namespace winmd files.
# Several SDK versions may be installed and not every one exposes Windows.Media.Ocr,
# so candidates are tried newest-first until one compiles.
$winmdCandidates = @()
$kits = 'C:\Program Files (x86)\Windows Kits\10\UnionMetadata'
if (Test-Path -LiteralPath $kits) {
  $winmdCandidates = @(
    Get-ChildItem $kits -Directory |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'Windows.winmd' } |
      Where-Object { Test-Path -LiteralPath $_ }
  )
}
if ($winmdCandidates.Count -eq 0) {
  throw 'Windows.winmd not found (Windows SDK UnionMetadata is required to build the OCR helper)'
}

# Facade reference assemblies carry the contracts WinRT metadata points at.
$facades = @()
$refRoots = @(
  'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\Facades',
  'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.7.2\Facades'
)
foreach ($root in $refRoots) {
  if (Test-Path -LiteralPath $root) { $facades = @($root); break }
}

# System.Runtime.WindowsRuntime.dll: where AsTask() lives. It ships with the desktop runtime.
$windowsRuntime = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Runtime.WindowsRuntime.dll'
if (-not (Test-Path -LiteralPath $windowsRuntime)) { throw "System.Runtime.WindowsRuntime.dll not found: $windowsRuntime" }

# System.Drawing: used by the per-pixel frame diff.
$drawing = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Drawing.dll'
if (-not (Test-Path -LiteralPath $drawing)) { throw "System.Drawing.dll not found: $drawing" }

$baseArguments = @(
  '/nologo',
  '/target:library',
  '/optimize+',
  ('/out:{0}' -f $dll),
  ('/reference:{0}' -f $windowsRuntime),
  ('/reference:{0}' -f $drawing)
)

foreach ($name in @('System.Runtime.dll', 'System.ObjectModel.dll', 'System.Collections.dll', 'System.Threading.Tasks.dll')) {
  foreach ($root in $facades) {
    $path = Join-Path $root $name
    if (Test-Path -LiteralPath $path) { $baseArguments += ('/reference:{0}' -f $path); break }
  }
}

$built = $false
$started = Get-Date
foreach ($winmd in $winmdCandidates) {
  $arguments = $baseArguments + @(('/reference:{0}' -f $winmd), $src)
  $output = & $csc $arguments 2>&1
  $code = $LASTEXITCODE
  if ($code -eq 0 -and (Test-Path -LiteralPath $dll)) {
    Write-Host ("winmd: {0}" -f $winmd)
    $built = $true
    break
  }
  Write-Host ("skip {0}: csc exit {1}" -f $winmd, $code)
  if ($output) { $output | Select-Object -First 3 | ForEach-Object { Write-Host ("  " + $_) } }
}
$ms = [int]((Get-Date) - $started).TotalMilliseconds
if (-not $built) { throw 'compile failed for every Windows.winmd candidate' }

$size = (Get-Item -LiteralPath $dll).Length
Write-Host ("built {0} ({1} bytes) in {2} ms" -f $dll, $size, $ms)

# Smoke test: load it and ask for the installed recognizers.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$bytes = [System.IO.File]::ReadAllBytes($dll)
$asm = [System.Reflection.Assembly]::Load($bytes)
$type = $asm.GetType('DshOcr')
if (-not $type) { throw 'DshOcr type missing from the built assembly' }
$langs = $type.GetMethod('Languages').Invoke($null, @())
Write-Host ("ocr languages: {0}" -f $langs)
