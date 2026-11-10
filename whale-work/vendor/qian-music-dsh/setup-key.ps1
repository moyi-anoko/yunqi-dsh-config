param([string]$BaseURL='https://dashscope.aliyuncs.com/compatible-mode/v1',[string]$Model='qwen3.8-omni-flash')
$ErrorActionPreference='Stop'
$directory=$env:QIAN_CONFIG_DIR
if(!$directory){$dshHome=$env:DSH_HOME;if(!$dshHome){$dshHome=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'};$directory=Join-Path $dshHome 'qian-music'}
$inputURL=Read-Host "百炼服务地址（直接回车使用 $BaseURL）"
if($inputURL){$BaseURL=$inputURL}
$uri=[uri]$BaseURL
if($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment){throw '需要有效的 HTTPS 服务地址'}
$inputModel=Read-Host "模型（直接回车使用 $Model）"
if($inputModel){$Model=$inputModel}
$secret=Read-Host '请输入你自己的百炼 API Key（隐藏输入）' -AsSecureString
if($secret.Length -eq 0){throw 'API Key 不能为空'}
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$secret | Export-Clixml -LiteralPath (Join-Path $directory 'qwen-key.xml')
@{baseURL=$uri.AbsoluteUri.TrimEnd('/');model=$Model} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'config.json') -Encoding utf8NoBOM
Write-Host '已使用 Windows 当前用户加密保存。请重启 DSH。'
