param([string]$DesktopPath)
$ErrorActionPreference='Stop'
$dshHome=$env:DSH_HOME
if(!$dshHome){$dshHome=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'}
$configDir=$env:QIAN_CONFIG_DIR
if(!$configDir){$configDir=Join-Path $dshHome 'qian-music'}
$launchFile=Join-Path $configDir 'desktop-launch.json'
if(!$DesktopPath -and (Test-Path -LiteralPath $launchFile)){$DesktopPath=(Get-Content -LiteralPath $launchFile -Raw | ConvertFrom-Json).desktopPath}
if(!$DesktopPath){$DesktopPath=(Read-Host '请输入已安装的 DeepSeek Harness.exe 完整路径').Trim('"')}
if(!(Test-Path -LiteralPath $DesktopPath -PathType Leaf)){throw '找不到桌面程序，请重新指定 -DesktopPath'}
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
@{desktopPath=$DesktopPath} | ConvertTo-Json | Set-Content -LiteralPath $launchFile -Encoding utf8NoBOM
$keyFile=Join-Path $configDir 'qwen-key.xml'
try {
 if(!$env:QIAN_OMNI_API_KEY -and (Test-Path -LiteralPath $keyFile)){$env:QIAN_OMNI_API_KEY=[System.Net.NetworkCredential]::new('',(Import-Clixml -LiteralPath $keyFile)).Password}
 $env:DSH_HOME=$dshHome
 Start-Process -FilePath $DesktopPath -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
} finally {Remove-Item Env:QIAN_OMNI_API_KEY -ErrorAction SilentlyContinue}
