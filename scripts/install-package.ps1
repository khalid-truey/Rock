param([ValidateSet('Host','Client')][string]$Mode)
$ErrorActionPreference = 'Stop'
$Setup = Join-Path $PSScriptRoot 'setup-rock.ps1'
if ($Mode -eq 'Client') {
    Add-Type -AssemblyName System.Windows.Forms
    $Dialog = New-Object System.Windows.Forms.OpenFileDialog
    $Dialog.Title = 'Choose the pairing file from your Laya host PC'
    $Dialog.Filter = 'Rock pairing file (*.rock-pairing.json)|*.rock-pairing.json'
    if ($Dialog.ShowDialog() -ne 'OK') { exit 0 }
    & $Setup -Mode Client -PairingFile $Dialog.FileName -RegisterChrome -SkipBuild
} else {
    $RockPython = Read-Host 'Full path to Python 3.12 (press Enter to use python from PATH)'
    if (-not $RockPython) { $RockPython = 'python' }
    & $Setup -Mode Host -Python $RockPython -RegisterChrome -SkipBuild
}
