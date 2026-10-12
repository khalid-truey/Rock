param([string]$OutputDir)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $RepoRoot 'bin' }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$Compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $Compiler)) { throw '.NET Framework 4.x compiler is required to build Rock Control.' }
$Exe = Join-Path $OutputDir 'Rock Control.exe'
$LocationSource = Join-Path $OutputDir 'RockControl.Location.cs'
$EscapedRoot = $RepoRoot.Replace('"','""')
[IO.File]::WriteAllText($LocationSource, ('internal static class InstalledLocation { internal const string Root = @"' + $EscapedRoot + '"; }'))
try {
    & $Compiler /nologo /target:winexe /platform:anycpu /optimize+ "/out:$Exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/win32manifest:$RepoRoot\apps\rock-control\app.manifest" (Join-Path $RepoRoot 'apps\rock-control\RockControl.cs') $LocationSource
} finally { Remove-Item -LiteralPath $LocationSource }
if ($LASTEXITCODE -ne 0) { throw 'Rock Control build failed. Close any open copy before rebuilding.' }
Write-Host "Built $Exe"
