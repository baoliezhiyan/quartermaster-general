param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

$runtimeRoot = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $runtimeRoot 'node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) {
    throw 'Node.js was not found. Install Node.js 22.12+ or 24 LTS and try again.'
}
$nodeVersion = [version]((& $nodePath --version).TrimStart('v'))
if ($nodeVersion -lt [version]'22.12.0') { throw 'Node.js 22.12+ is required.' }
$env:PATH = "$(Split-Path -Parent $nodePath);$env:PATH"

$vitePath = Join-Path (Get-Location).Path 'node_modules/vite/bin/vite.js'
if (-not (Test-Path -LiteralPath $vitePath)) {
    $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
    $pnpmPath = if ($pnpmCommand) { $pnpmCommand.Source } else { Join-Path $runtimeRoot 'bin/fallback/pnpm.cmd' }
    if (-not (Test-Path -LiteralPath $pnpmPath)) { throw 'pnpm was not found. Install pnpm 11 and try again.' }
    & $pnpmPath install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
Write-Host 'Quartermaster General: http://127.0.0.1:5173'
Write-Host 'Keep this window open. Press Ctrl+C to stop.'
$viteArguments = @($vitePath, '--host', '127.0.0.1')
if (-not $NoOpen) { $viteArguments += '--open' }
& $nodePath @viteArguments
if ($LASTEXITCODE -ne 0) { throw 'Unable to start the game. Check whether port 5173 is already in use.' }
