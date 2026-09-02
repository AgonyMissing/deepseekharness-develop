!macro customInit
  ; 安装器初始化时强制结束旧实例，避免 “无法关闭” 拦截
  nsExec::ExecToLog 'taskkill /F /IM "DeepSeek Harness.exe"'
  Sleep 1200
!macroend
