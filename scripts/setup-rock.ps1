param(
    [ValidateSet('Host','Client')][string]$Mode = 'Host',
    [string]$PairingFile,
    [string]$Python = 'python',
    [string]$LayaDataDir,
    [switch]$SkipLaya,
    [switch]$SkipBuild,
    [switch]$RegisterChrome,
    [switch]$OpenFirewall,
    [switch]$NoShortcuts
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Rock setup requires Windows x64.' }
if ($Mode -eq 'Client' -and -not $PairingFile) { throw 'Client mode requires -PairingFile from your host PC.' }
if ($Mode -eq 'Client' -and $OpenFirewall) { throw 'Only Host mode needs an inbound firewall rule.' }
$RepoRoot = Split-Path -Parent $PSScriptRoot
$IntegrationDir = Join-Path $RepoRoot 'integrations\codex'
$RockData = if ($env:ROCK_DATA_DIR) { [IO.Path]::GetFullPath($env:ROCK_DATA_DIR) } else { Join-Path $RepoRoot '.rock-data' }
if (-not $LayaDataDir) { $LayaDataDir = $RockData }
$NodePath = Join-Path $RepoRoot 'bin\node.exe'
$Packaged = Test-Path -LiteralPath (Join-Path $RepoRoot 'bin\rock.exe')
if (-not (Test-Path -LiteralPath $NodePath)) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
function Assert-Exit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit $LASTEXITCODE)." } }
Push-Location $RepoRoot
try {
    if (-not $Packaged) {
        & npm.cmd ci --prefix $IntegrationDir
        Assert-Exit 'Install Node dependencies'
        if (-not $SkipBuild) {
            & cargo build --locked -p pok-ai-cli --bins
            Assert-Exit 'Build Rock'
        }
    }
    $BinDir = if ($Packaged) { Join-Path $RepoRoot 'bin' } else { Join-Path $RepoRoot 'target\debug' }
    foreach ($Binary in @('rock.exe','rock-chrome-host.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $BinDir $Binary))) { throw "Missing $Binary. Build Rock first." }
    }
    New-Item -ItemType Directory -Force -Path $RockData | Out-Null
    # Limit credentials/certificates to this Windows user, SYSTEM and administrators.
    $UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $RockData /inheritance:r /grant:r "*${UserSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    Assert-Exit 'Protect local runtime data'
    if ($Mode -eq 'Host') {
        if (-not $SkipLaya) { & (Join-Path $PSScriptRoot 'setup-laya.ps1') -DataDir $LayaDataDir -Python $Python }
        $Pfx = Join-Path $RockData 'host-certificate.pfx'
        if (-not (Test-Path -LiteralPath $Pfx)) {
            $RandomBytes = New-Object byte[] 32
            $Rng = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $Rng.GetBytes($RandomBytes) } finally { $Rng.Dispose() }
            $Password = [Convert]::ToBase64String($RandomBytes)
            $Cert = New-SelfSignedCertificate -DnsName 'localhost','rock-laya-host' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable -Type SSLServerAuthentication -NotAfter (Get-Date).AddYears(2)
            try {
                Export-PfxCertificate -Cert $Cert -FilePath $Pfx -Password (ConvertTo-SecureString $Password -AsPlainText -Force) | Out-Null
                $Pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($Cert.RawData,[Base64FormattingOptions]::InsertLineBreaks) + "`n-----END CERTIFICATE-----`n"
                [IO.File]::WriteAllText((Join-Path $RockData 'host-certificate.pem'),$Pem)
                [IO.File]::WriteAllText((Join-Path $RockData 'host-certificate-password'),$Password)
            } finally { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($Cert.Thumbprint)" }
        }
        & $NodePath (Join-Path $IntegrationDir 'configure.mjs') Host $LayaDataDir
    } else {
        & $NodePath (Join-Path $IntegrationDir 'configure.mjs') Client $PairingFile
    }
    Assert-Exit 'Configure shared Laya'
    $ChromeArgs = @((Join-Path $IntegrationDir 'install-chrome.mjs'))
    if ($RegisterChrome) { $ChromeArgs += '--register' }
    & $NodePath @ChromeArgs
    Assert-Exit 'Configure Chrome native helper'
    if ($OpenFirewall) {
        if (-not (Get-NetFirewallRule -Name 'Rock-Laya-LAN' -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -Name 'Rock-Laya-LAN' -DisplayName 'Rock Laya - private LAN only' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 43129 -Profile Private -RemoteAddress LocalSubnet -Program $NodePath | Out-Null
        }
    }
    # Visible shortcuts are opened by the user. No scheduled task or startup service.
    if (-not $NoShortcuts) {
        $Wsh = New-Object -ComObject WScript.Shell
        $DesktopDir = [Environment]::GetFolderPath('Desktop')
        $Actions = @{ 'Rock Status' = 'status' }
        if ($Mode -eq 'Host') { $Actions['Start Laya'] = 'host-start'; $Actions['Stop Laya'] = 'host-stop'; $Actions['Laya Host Status'] = 'host-status' }
        foreach ($Entry in $Actions.GetEnumerator()) {
            $Shortcut = $Wsh.CreateShortcut((Join-Path $DesktopDir ($Entry.Key + '.lnk')))
            $Shortcut.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
            $Shortcut.Arguments = '-NoProfile -NoExit -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'rock.ps1') + '" ' + $Entry.Value
            $Shortcut.WorkingDirectory = $RepoRoot
            $Shortcut.Save()
        }
    }
    Write-Host "Rock $Mode setup complete. No Laya process has been started."
    Write-Host "MCP config: $IntegrationDir\codex.local.toml or mcp.local.json"
    if ($Mode -eq 'Host') {
        Write-Host 'Open Start Laya when needed. To pair a laptop, reserve the PC LAN IP, then:'
        Write-Host '.\scripts\rock.ps1 pair laptop https://YOUR-PC-LAN-IP:43129'
        if (-not $OpenFirewall) { Write-Host 'Allow TCP 43129 on Private/LocalSubnet through Windows Firewall, or rerun setup with -OpenFirewall in an administrator terminal.' }
    } else { Write-Host 'Laptop is ready. Load its Chrome extension and connect its local MCP. The host PC owns the model.' }
} finally { Pop-Location }
