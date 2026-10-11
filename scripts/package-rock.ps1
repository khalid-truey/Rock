param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PackageRoot = Join-Path $RepoRoot ('target\packages\Rock-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path (Join-Path $PackageRoot 'bin') | Out-Null
Push-Location $RepoRoot
try {
    if (-not $SkipBuild) {
        & cargo build --locked --release -p pok-ai-cli --bins
        if ($LASTEXITCODE -ne 0) { throw 'Rock build failed.' }
    }
    foreach ($Binary in @('rock.exe','rock-chrome-host.exe','pok-ai.exe')) {
        Copy-Item -LiteralPath (Join-Path $RepoRoot "target\release\$Binary") -Destination (Join-Path $PackageRoot "bin\$Binary")
    }
    $NodePath = (Get-Command node).Source
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $PackageRoot 'bin\node.exe')
    $NodeLicense = Join-Path (Split-Path -Parent $NodePath) 'LICENSE'
    $BundledLicense = Join-Path $PackageRoot 'bin\NODE-LICENSE.txt'
    if (Test-Path -LiteralPath $NodeLicense) {
        Copy-Item -LiteralPath $NodeLicense -Destination $BundledLicense
    } else {
        $NodeVersion = (& $NodePath --version).Trim()
        if ($NodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'Cannot determine the bundled Node license version.' }
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$NodeVersion/LICENSE" -OutFile $BundledLicense
    }
    # Explicit source allowlist: never copy .rock-data, local config, profiles or keys.
    $Files = @('README.md','LICENSE','NOTICE','rock.example.toml','docs/SHARED-LAYA.md',
        'scripts/setup-rock.ps1','scripts/setup-laya.ps1','scripts/laya_sidecar.py','scripts/rock.ps1','scripts/install-package.ps1')
    $Files += @(git ls-files integrations/codex | Where-Object {
        $_ -match '\.(mjs|js|json|html|md)$' -and $_ -notmatch '\.test\.mjs$'
    })
    # New integration files may be uncommitted when preparing a preview package.
    $Files += @('integrations/codex/configure.mjs','integrations/codex/shared-laya.mjs','integrations/codex/laya-host.mjs')
    foreach ($Relative in ($Files | Sort-Object -Unique)) {
        $Destination = Join-Path $PackageRoot $Relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
        Copy-Item -LiteralPath (Join-Path $RepoRoot $Relative) -Destination $Destination
    }
    & npm.cmd ci --omit=dev --prefix (Join-Path $PackageRoot 'integrations\codex')
    if ($LASTEXITCODE -ne 0) { throw 'Could not package Node dependencies.' }
    foreach ($Mode in @('Host','Client')) {
        $Label = if ($Mode -eq 'Client') { 'Laptop' } else { 'Host' }
        [IO.File]::WriteAllText((Join-Path $PackageRoot "Setup $Label.cmd"),"@echo off`r`npowershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File `"%~dp0scripts\install-package.ps1`" -Mode $Mode`r`npause`r`n")
    }
    foreach ($Entry in @{ 'Start Laya'='host-start'; 'Stop Laya'='host-stop'; 'Rock Status'='status'; 'Laya Host Status'='host-status' }.GetEnumerator()) {
        [IO.File]::WriteAllText((Join-Path $PackageRoot ($Entry.Key + '.cmd')),"@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0scripts\rock.ps1`" $($Entry.Value)`r`npause`r`n")
    }
    $Zip = $PackageRoot + '.zip'
    Compress-Archive -LiteralPath $PackageRoot -DestinationPath $Zip -CompressionLevel Optimal
    (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash + '  ' + (Split-Path -Leaf $Zip) | Set-Content -LiteralPath ($Zip + '.sha256')
    Write-Host "Portable package: $Zip"
} finally { Pop-Location }
