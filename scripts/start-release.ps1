param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$latestFile = Join-Path $projectRoot 'releases/latest.json'
if (-not (Test-Path -LiteralPath $latestFile)) { throw 'No release found. Run pnpm release first, or use the development launcher.' }
$latestRelease = Get-Content -LiteralPath $latestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$releaseName = Split-Path -Leaf $latestRelease.folder
$releaseFolder = Join-Path (Join-Path $projectRoot 'releases') $releaseName
$releaseNode = Join-Path $releaseFolder 'runtime/node.exe'
$releaseServer = Join-Path $releaseFolder 'server.mjs'
if (-not (Test-Path -LiteralPath $releaseNode)) { throw 'Release runtime is missing. Extract the complete release again.' }
$releaseArguments = @($releaseServer)
if ($NoOpen) { $releaseArguments += '--no-open' }
& $releaseNode @releaseArguments
exit $LASTEXITCODE
