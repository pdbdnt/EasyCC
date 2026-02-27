$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath "EasyCC.lnk"

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($shortcutPath)
$sc.TargetPath = "wscript.exe"
$sc.Arguments = "`"$projectDir\launch-silent.vbs`""
$sc.WorkingDirectory = $projectDir
$sc.IconLocation = "$projectDir\electron\icon.ico,0"
$sc.Description = "EasyCC - Build and Launch"
$sc.Save()

Write-Host "Desktop shortcut created: $shortcutPath"
Write-Host "Right-click it and select 'Pin to taskbar' to add it to your taskbar."
