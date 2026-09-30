$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$env:QM_PUBLIC_ORIGIN = (Read-Host '粘贴 cpolar 已建立的 https:// 公网网址').Trim()
if (!$env:QM_PUBLIC_ORIGIN.StartsWith('https://')) { throw '请填写完整的 HTTPS 公网网址。' }
& (Join-Path $taskRoot 'runtime/node.exe') (Join-Path $taskRoot 'scripts/multiplayer-server.mjs') --open
exit $LASTEXITCODE
