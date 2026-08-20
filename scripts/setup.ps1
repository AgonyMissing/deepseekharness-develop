<#
  DeepSeek Harness 桌面端 —— 依赖安装 + 定制内容还原

  用途：
    git clone 之后跑一次本脚本，装齐所有依赖，并把已移出 git 的
    定制内容（7 只自定义宠物素材、宠物召唤隐藏补丁、侧边栏默认不自动展开补丁）
    重新放回 node_modules。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
    依赖已经装好、只想恢复定制内容时：
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -SkipInstall
#>
param(
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step {
  param([string]$Name)
  Write-Host "`n=== $Name ===" -ForegroundColor Cyan
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "缺少命令: $Name（请先安装 Node.js 和 pnpm）"
  }
}

Assert-Command 'node'
Assert-Command 'npm'
Assert-Command 'pnpm'

# ---------- 1. 安装依赖 ----------
if (-not $SkipInstall) {
  Write-Step '安装根目录依赖 (electron / electron-builder)'
  & npm install
  if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }

  foreach ($dir in @('resources\dsh', 'resources\dsh-web-ui')) {
    Write-Step "安装 $dir 依赖 (pnpm)"
    Push-Location (Join-Path $root $dir)
    try {
      & pnpm install
      if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败: $dir" }
    } finally {
      Pop-Location
    }
  }
} else {
  Write-Step '跳过依赖安装 (-SkipInstall)'
}

# ---------- 2. 还原自定义宠物素材 ----------
Write-Step '还原自定义宠物素材'
$petSrc = Join-Path $root 'resources\dsh-web-ui\pet-assets'
$petDst = Join-Path $root 'resources\dsh-web-ui\node_modules\@linxin666\dsh-pet\assets'
if (Test-Path $petSrc) {
  if (-not (Test-Path $petDst)) {
    throw "找不到宠物包目录: $petDst（请先安装依赖）"
  }
  Get-ChildItem $petSrc -Directory | ForEach-Object {
    $target = Join-Path $petDst $_.Name
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item (Join-Path $_.FullName '*') $target -Recurse -Force
    Write-Output "pet asset: $($_.Name)"
  }
} else {
  Write-Warning "未找到宠物素材目录: $petSrc（跳过）"
}

# ---------- 3. 宠物召唤按钮隐藏补丁 ----------
Write-Step '应用宠物召唤按钮隐藏补丁'
function Update-PetSummonPatch {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    Write-Warning "缺少文件: $Path"
    return
  }
  $raw = [IO.File]::ReadAllText($Path)
  $pattern = '(?s)(\t\t\tconst display = snapshot\?\.display \?\? DEFAULT_DISPLAY;\r?\n)[\s\S]*?(\r?\n\t\t\}\r?\n\t\t//#endregion src/contracts/renderer)'
  $replacement = '$1' + "`t`t`treturn null;" + '$2'
  $next = [regex]::Replace($raw, $pattern, $replacement)
  if ($next -eq $raw) {
    if ($raw -match '(?s)DEFAULT_DISPLAY;\r?\n\t\t\treturn null;') {
      Write-Output "already patched: $Path"
    } else {
      Write-Warning "未能自动匹配补丁位置: $Path（可能需要人工检查）"
    }
  } else {
    [IO.File]::WriteAllText($Path, $next)
    Write-Output "patched: $Path"
  }
}
Update-PetSummonPatch (Join-Path $root 'resources\dsh-web-ui\node_modules\@linxin666\dsh-pet\lib\client.js')

# ---------- 4. 侧边栏默认不自动展开补丁 ----------
Write-Step '应用侧边栏默认不自动展开补丁'
function Update-BetterSidebarDefaults {
  param([string]$Dir)
  $targets = @(
    'src\prefs-shared.ts',
    'src\config.ts',
    'lib\index.js',
    'lib\client-registry.js',
    'lib\client.js'
  )
  foreach ($rel in $targets) {
    $p = Join-Path $Dir $rel
    if (-not (Test-Path $p)) { continue }
    $raw = [IO.File]::ReadAllText($p)
    $next = $raw
    $next = $next.Replace('autoOpenSubagent: z.boolean().default(true)', 'autoOpenSubagent: z.boolean().default(false)')
    $next = $next.Replace('autoOpenJobs: z.boolean().default(true)', 'autoOpenJobs: z.boolean().default(false)')
    $next = $next.Replace('autoOpenSubagent: true,', 'autoOpenSubagent: false,')
    $next = $next.Replace('autoOpenJobs: true,', 'autoOpenJobs: false,')
    if ($next -ne $raw) {
      [IO.File]::WriteAllText($p, $next)
      Write-Output "patched: $rel"
    } else {
      Write-Output "already patched: $rel"
    }
  }
}
Update-BetterSidebarDefaults (Join-Path $root 'resources\dsh-web-ui\node_modules\dsh-better-sidebar')

# ---------- 5. 移动端远程控制面板：显示本机端口 ----------
Write-Step '应用移动端远程控制端口显示补丁'
function Update-RemotePortPatch {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    Write-Warning "缺少文件: $Path"
    return
  }
  $raw = [IO.File]::ReadAllText($Path)
  if ($raw.Contains('本机服务地址：http://127.0.0.1:17890')) {
    Write-Output "already patched: $Path"
    return
  }
  $insert = @'
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: remote_module_css_default.hint,
						children: "本机服务地址：http://127.0.0.1:17890（内网穿透请映射 127.0.0.1:17890）"
					}),
'@
  $insert = $insert.TrimEnd("`r", "`n")
  $anchor = "`t`t`t`t}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: ["
  $next = $raw.Replace($anchor, $anchor + "`n" + $insert + "`n")
  if ($next -eq $raw) {
    Write-Warning "未能自动匹配远程控制面板位置: $Path（可能需要人工检查）"
  } else {
    [IO.File]::WriteAllText($Path, $next)
    Write-Output "patched: $Path"
  }
}
Update-RemotePortPatch (Join-Path $root 'resources\dsh-web-ui\node_modules\@linxin666\dsh-remote-web-ui\lib\client.js')

Write-Host "`n完成。接下来可以运行 npm run dist 打包，或 npm start 启动开发版。" -ForegroundColor Green
