# Runs `indexd usn-probe` on a Windows volume and writes the output to a file.
#
#   powershell -ExecutionPolicy Bypass -File scripts\usn-probe.ps1
#   scripts\usn-probe.cmd            (double-click friendly)
#
# The probe needs administrator rights because opening \\.\C: is privileged.
# When this script is already elevated it runs the probe directly; otherwise it
# asks Windows for elevation (UAC). Output goes to _usn-probe.txt next to the
# repository so a closing console cannot lose it.
#
#   ... -Root "C:\Users\me" -Volume D:
#   ... -NoElevate        # only checks the graceful "Access is denied" path
param(
    [string]$Volume = 'C:',
    [string]$Root = 'C:\Windows',
    [string]$Output = '',
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $here
$exe = Join-Path $rootDir 'bin\win32-x64\indexd.exe'

function Stop-WithMessage([string]$message) {
    Write-Host ''
    Write-Host "usn-probe: $message" -ForegroundColor Red
    Write-Host ''
    Write-Host 'Nothing was changed.'
    if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
        Read-Host 'Press Enter to close' | Out-Null
    }
    exit 1
}

if (-not (Test-Path -LiteralPath $exe)) {
    Stop-WithMessage "engine binary not found: $exe`nBuild it with: node scripts/build-engine.mjs --all"
}
if ([string]::IsNullOrWhiteSpace($Output)) {
    $Output = Join-Path $rootDir '_usn-probe.txt'
}
$Output = [System.IO.Path]::GetFullPath($Output)

# Argument line for System.Diagnostics.ProcessStartInfo: quote values with spaces.
$argumentValues = @('usn-probe', '--volume', $Volume, '--root', $Root, '--limit', '5', '--journal', '5')
$argumentLine = ($argumentValues | ForEach-Object {
    if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
}) -join ' '

function Invoke-Probe([string]$outFile) {
    # .NET redirection avoids PowerShell's native-stderr ErrorRecord noise and
    # cmd.exe's quote parsing.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $argumentLine
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($psi)
    $text = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    [System.IO.File]::WriteAllText($outFile, $text, (New-Object System.Text.UTF8Encoding($false)))
    return $process.ExitCode
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)

Write-Host "engine: $exe"
Write-Host "volume: $Volume  root: $Root"
Write-Host "output: $Output"
Write-Host ''

if ($NoElevate) {
    $code = Invoke-Probe $Output
    Write-Host "exit code: $code"
    if (Test-Path -LiteralPath $Output) { Get-Content -LiteralPath $Output }
    exit $code
}

if ($isAdmin) {
    $code = Invoke-Probe $Output
    Write-Host "exit code: $code"
    Write-Host ''
    Write-Host "----- $Output -----"
    if (Test-Path -LiteralPath $Output) { Get-Content -LiteralPath $Output }
    Write-Host '----- end -----'
    if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
        Read-Host 'Press Enter to close' | Out-Null
    }
    exit $code
}

# Not elevated: a temporary runner repeats the same .NET redirection under an
# elevated PowerShell, so no nested cmd quoting is involved.
function Quote-PS([string]$value) { return "'" + $value.Replace("'", "''") + "'" }
$runner = Join-Path $env:TEMP ("dsh-locator-usn-probe-{0}.ps1" -f $PID)
$runnerText = @"
`$psi = New-Object System.Diagnostics.ProcessStartInfo
`$psi.FileName = $(Quote-PS $exe)
`$psi.Arguments = $(Quote-PS $argumentLine)
`$psi.UseShellExecute = `$false
`$psi.RedirectStandardOutput = `$true
`$psi.RedirectStandardError = `$true
`$psi.CreateNoWindow = `$true
`$process = [System.Diagnostics.Process]::Start(`$psi)
`$text = `$process.StandardOutput.ReadToEnd() + `$process.StandardError.ReadToEnd()
`$process.WaitForExit()
[System.IO.File]::WriteAllText($(Quote-PS $Output), `$text, (New-Object System.Text.UTF8Encoding(`$false)))
exit `$process.ExitCode
"@
Set-Content -LiteralPath $runner -Value $runnerText -Encoding UTF8

try {
    Write-Host 'Requesting administrator rights (UAC prompt)...'
    $process = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner) `
        -Verb RunAs -Wait -PassThru
} catch {
    Remove-Item -LiteralPath $runner -ErrorAction SilentlyContinue
    Stop-WithMessage "elevation was cancelled or refused: $($_.Exception.Message)"
}
Remove-Item -LiteralPath $runner -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "probe finished with exit code $($process.ExitCode)"
if (Test-Path -LiteralPath $Output) {
    Write-Host ''
    Write-Host "----- $Output -----"
    Get-Content -LiteralPath $Output
    Write-Host '----- end -----'
} else {
    Write-Host 'no output file was written; run this script from an elevated PowerShell to see the error directly.'
}
if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
    Read-Host 'Press Enter to close' | Out-Null
}
