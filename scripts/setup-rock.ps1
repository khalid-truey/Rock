param(
    [string]$Python = 'python',
    [switch]$SkipLaya,
    [switch]$SkipBuild,
    [switch]$RegisterChrome
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Rock setup requires Windows x64.' }
$RepoRoot = Split-Path -Parent $PSScriptRoot
$IntegrationDir = Join-Path $RepoRoot 'integrations\codex'
$RockData = Join-Path $RepoRoot '.rock-data'
$ConfigFile = Join-Path $RepoRoot 'pok-ai.toml'
$NodePath = (Get-Command node -ErrorAction Stop).Source

function Assert-Exit([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit $LASTEXITCODE)." }
}

Push-Location $RepoRoot
try {
    & npm.cmd ci --prefix $IntegrationDir
    Assert-Exit 'Install Node dependencies'
    if (-not $SkipBuild) {
        & cargo build --locked -p pok-ai-cli --bins
        Assert-Exit 'Build Rock'
    }
    foreach ($Binary in @('rock.exe', 'rock-chrome-host.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "target\debug\$Binary"))) {
            throw "Missing $Binary. Run setup without -SkipBuild."
        }
    }
    New-Item -ItemType Directory -Force -Path $RockData | Out-Null
    if (-not (Test-Path -LiteralPath $ConfigFile)) {
        # JSON escaping is compatible with TOML basic strings for a Windows path.
        $EscapedData = (ConvertTo-Json ($RockData.Replace('\', '/')) -Compress)
        $EscapedData = $EscapedData.Substring(1, $EscapedData.Length - 2)
        $Template = [IO.File]::ReadAllText((Join-Path $RepoRoot 'rock.example.toml'))
        [IO.File]::WriteAllText($ConfigFile, $Template.Replace('@DATA_DIR@', $EscapedData))
    } else {
        Write-Host 'Keeping existing pok-ai.toml. Check its data_dir if you moved the checkout.'
    }
    if (-not $SkipLaya) {
        & (Join-Path $PSScriptRoot 'setup-laya.ps1') -DataDir $RockData -Python $Python
    }
    $ChromeArgs = @((Join-Path $IntegrationDir 'install-chrome.mjs'))
    if ($RegisterChrome) { $ChromeArgs += '--register' }
    & $NodePath @ChromeArgs
    Assert-Exit 'Generate Chrome native host configuration'

    $Launcher = Join-Path $IntegrationDir 'runtime.mjs'
    $Mcp = @{ mcpServers = @{ rock = @{ command = $NodePath; args = @($Launcher, 'mcp') } } }
    [IO.File]::WriteAllText((Join-Path $IntegrationDir 'mcp.local.json'), ($Mcp | ConvertTo-Json -Depth 6) + "`n")
    $NodeToml = ConvertTo-Json $NodePath -Compress
    $LauncherToml = ConvertTo-Json $Launcher -Compress
    $CodexConfig = @"
[mcp_servers.rock]
command = $NodeToml
args = [$LauncherToml, "mcp"]
startup_timeout_sec = 240
tool_timeout_sec = 240
"@
    [IO.File]::WriteAllText((Join-Path $IntegrationDir 'codex.local.toml'), $CodexConfig + "`n")
    Write-Host 'Rock setup complete. MCP configuration examples:'
    Write-Host (Join-Path $IntegrationDir 'codex.local.toml')
    Write-Host (Join-Path $IntegrationDir 'mcp.local.json')
    Write-Host 'Next: node integrations/codex/runtime.mjs status'
    Write-Host 'Then follow README.md to connect your MCP client and load the Chrome extension.'
} finally {
    Pop-Location
}
