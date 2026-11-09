# Runs `indexd usn-probe` on a Windows volume and writes the output to a file.
#
#   powershell -ExecutionPolicy Bypass -File scripts\usn-probe.ps1
#
# The default start requests elevation (UAC) because opening \\.\C: needs
# administrator rights. The result is written next to the repository as
# _usn-probe.txt so the console window can close without losing it.
#
#   ... -Root "C:\Users\me" -Volume D:
#
# Use -NoElevate only to check the command's graceful "Access is denied" path.
param(
    [string]$Volume = 'C:',
    [string]$Root = 'C:\Windows',
    [string]$Output = '',
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path (Split-Path -Parent $here) 'bin\win32-x64\indexd.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    throw "engine binary not found: $exe (run 'node scripts/build-engine.mjs --all')"
}
if ([string]::IsNullOrWhiteSpace($Output)) {
    $Output = Join-Path (Split-Path -Parent $here) '_usn-probe.txt'
}
$Output = [System.IO.Path]::GetFullPath($Output)

$arguments = @(
    'usn-probe',
    '--volume', $Volume,
    '--root', $Root,
    '--limit', '5',
    '--journal', '5'
)

if ($NoElevate) {
    # Native stderr becomes an ErrorRecord; keep it flowing into the file
    # instead of tripping $ErrorActionPreference.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $exe @arguments 2>&1 | Tee-Object -FilePath $Output
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    exit $code
}

$commandLine = '"{0}" {1} > "{2}" 2>&1' -f $exe, ($arguments -join ' '), $Output
Start-Process -FilePath $env:ComSpec -ArgumentList '/c', $commandLine -Verb RunAs -Wait
Write-Host "probe output written to $Output"
Get-Content -LiteralPath $Output
