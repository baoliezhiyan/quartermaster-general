$ErrorActionPreference = 'Stop'
$gameFolder = Split-Path -Parent $PSScriptRoot
$cloudflareFolder = Join-Path $gameFolder 'cloudflare'
$cloudflared = @((Join-Path $cloudflareFolder 'cloudflared.exe'),(Join-Path $cloudflareFolder 'cloudflared-windows-amd64.exe')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$cloudflared) {
    Write-Host '请先从 Cloudflare 官方下载 Windows 64 位 cloudflared，放到游戏目录内的 cloudflare 文件夹。'
    Write-Host 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/'
    exit 1
}
Write-Host '等窗口出现 https://...trycloudflare.com 网址后，复制它，再运行「2-启动联机游戏服务.cmd」。'
Write-Host '请保持此窗口运行。隧道刚创建而游戏服务尚未启动时，暂时无法打开网页是正常的。'
& $cloudflared tunnel --url http://127.0.0.1:4183
exit $LASTEXITCODE
