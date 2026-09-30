$ErrorActionPreference = 'Stop'
Write-Host '首次设置：请在 https://dashboard.cpolar.com/ 注册并复制认证令牌（AuthToken）。'
Write-Host '令牌只保存在本机用户目录，不在游戏压缩包中。输入时不会显示。'
$taskSecret = Read-Host '粘贴认证令牌' -AsSecureString
$taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
try { $taskToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
if ([string]::IsNullOrWhiteSpace($taskToken) -or $taskToken -match '\s') { throw '令牌为空或包含空格，请重新复制认证令牌。' }
$taskRegion = (Read-Host '地区（免费通常填 cn；固定网址填与官网保留地区一致的代码，直接回车使用 cn）').Trim()
if (!$taskRegion) { $taskRegion = 'cn' }
if ($taskRegion -notmatch '^[a-z][a-z0-9_]*$') { throw '地区代码格式错误。' }
$taskDomain = (Read-Host '保留子域名名称（免费版直接回车；付费版先在官网保留，不要填完整网址）').Trim()
if ($taskDomain -and $taskDomain -notmatch '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$') { throw '子域名名称格式错误。' }
$taskDir = Join-Path $env:LOCALAPPDATA 'QuartermasterGeneral/cpolar'
New-Item -ItemType Directory -Force -Path $taskDir | Out-Null
$taskYaml = 'authtoken: ' + (ConvertTo-Json -InputObject $taskToken -Compress) + "`n"
[IO.File]::WriteAllText((Join-Path $taskDir 'cpolar.yml'),$taskYaml,(New-Object Text.UTF8Encoding($false)))
$taskSettings = @{region=$taskRegion;subdomain=$taskDomain} | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $taskDir 'settings.json'),$taskSettings,(New-Object Text.UTF8Encoding($false)))
$taskToken = $null
Write-Host '配置已保存。之后可直接双击外层「启动联机版游戏（cpolar）」；更换游戏版本仍可复用此配置。'
