!macro customInit
  ; 安装器初始化时强制结束旧实例，避免 “无法关闭” 拦截
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /C taskkill /F /IM "DeepSeek Harness.exe" /FI "USERNAME eq %USERNAME%"'
  Sleep 1200
!macroend

!macro customCheckAppRunning
  ; 安装段开始前再强杀一次，确保任何用户双击安装都不会被旧实例拦截
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /C taskkill /F /IM "DeepSeek Harness.exe" /FI "USERNAME eq %USERNAME%"'
  Sleep 1200
!macroend
