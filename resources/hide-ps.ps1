# PowerShell启动器：设置控制台模式为后台，抑制窗口创建
[Console]::WindowVisible = $false
$host.UI.RawUI.WindowTitle = ''
