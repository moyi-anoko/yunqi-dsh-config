param([ValidateSet('read','write')][string]$Action,[string]$Directory)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$null=New-Item -ItemType Directory -Path $Directory -Force
$file=Join-Path $Directory 'qwen-key.xml'
if($Action -eq 'write'){
 $value=[Console]::In.ReadToEnd()
 ConvertTo-SecureString -String $value -AsPlainText -Force | Export-Clixml -LiteralPath $file
}elseif(Test-Path -LiteralPath $file){
 [Console]::Write([System.Net.NetworkCredential]::new('',(Import-Clixml -LiteralPath $file)).Password)
}
