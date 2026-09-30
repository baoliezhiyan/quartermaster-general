param([switch]$Internet, [string]$PublicOrigin = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$latest = Get-Content -LiteralPath (Join-Path $projectRoot 'releases/multiplayer-latest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$releaseFolder = Join-Path (Join-Path $projectRoot 'releases') (Split-Path -Leaf $latest.folder)
# Carry local users and the last autosave forward only when this new release has no data.
$targetData = Join-Path $releaseFolder 'data'
if (!(Test-Path -LiteralPath $targetData) -and $latest.previousFolder) {
    $previousRelease = Join-Path (Join-Path $projectRoot 'releases') (Split-Path -Leaf $latest.previousFolder)
    $previousData = Join-Path $previousRelease 'data'
    $previousLock = Join-Path $previousData 'server.lock'
    if (Test-Path -LiteralPath $previousLock) {
        $previousServerId = [int](Get-Content -LiteralPath $previousLock)
        if (Get-Process -Id $previousServerId -ErrorAction SilentlyContinue) {
            Write-Host '请先关闭旧版多人服务窗口，再重新启动。升级会保留原来的身份和自动存档。'
            exit 1
        }
    }
    if (Test-Path -LiteralPath $previousData) {
        New-Item -ItemType Directory -Path $targetData | Out-Null
        foreach ($dataName in @('identities.json','current-game.json','current-game.journal')) {
            $sourceFile = Join-Path $previousData $dataName
            if (Test-Path -LiteralPath $sourceFile) { Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $targetData $dataName) }
        }
    }
}
if ($Internet) {
    & (Join-Path $releaseFolder 'runtime/node.exe') (Join-Path $releaseFolder 'scripts/start-online.mjs')
} else {
    $env:QM_PUBLIC_ORIGIN = ''
    & (Join-Path $releaseFolder 'runtime/node.exe') (Join-Path $releaseFolder 'scripts/multiplayer-server.mjs') --open
}
exit $LASTEXITCODE
