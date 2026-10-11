param(
    [ValidateSet('start','stop','status','mcp','desktop','run','host-start','host-stop','host-status','pair','revoke')]
    [string]$Action = 'status',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Remaining
)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$NodePath = Join-Path $RepoRoot 'bin\node.exe'
if (-not (Test-Path -LiteralPath $NodePath)) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
if ($Action -in @('host-start','host-stop','host-status','pair','revoke')) {
    & $NodePath (Join-Path $RepoRoot 'integrations\codex\laya-host.mjs') ($Action -replace '^host-','') @Remaining
} else {
    & $NodePath (Join-Path $RepoRoot 'integrations\codex\runtime.mjs') $Action @Remaining
}
exit $LASTEXITCODE
