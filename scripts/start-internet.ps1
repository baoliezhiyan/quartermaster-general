$ErrorActionPreference = 'Stop'
$releaseFolder = Split-Path -Parent $PSScriptRoot
Write-Host '这是手动备用入口。请先启动隧道，复制其网址；游戏期间两个 CMD 窗口都要保持开启。'
$env:QM_PUBLIC_ORIGIN = (Read-Host '粘贴 cloudflared 显示的 https:// 公网入口网址').Trim()
if (!$env:QM_PUBLIC_ORIGIN) { throw '公网入口不能为空。' }
& (Join-Path $releaseFolder 'runtime/node.exe') (Join-Path $releaseFolder 'scripts/multiplayer-server.mjs') --open
exit $LASTEXITCODE
