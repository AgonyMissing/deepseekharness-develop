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
  # 0.2.x: PetDockEntry 的召唤按钮分支以带路径的 //#endregion src/contracts/renderer 结尾
  $patternLegacy = '(?s)(\t\t\tconst display = snapshot\?\.display \?\? DEFAULT_DISPLAY;\r?\n)[\s\S]*?(\r?\n\t\t\}\r?\n\t\t//#endregion src/contracts/renderer)'
  # 0.3.x: 结尾变成裸 //#endregion（紧接着 //#region src/contracts/renderer.ts）
  $patternNew = '(?s)(\t\t\tconst display = snapshot\?\.display \?\? DEFAULT_DISPLAY;\r?\n)[\s\S]*?(\r?\n\t\t\}\r?\n\t\t//#endregion\r?\n)'
  $replacement = '$1' + "`t`t`treturn null;" + '$2'
  $next = [regex]::Replace($raw, $patternLegacy, $replacement)
  if ($next -eq $raw) {
    $next = [regex]::Replace($raw, $patternNew, $replacement)
  }
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

Write-Step '应用创意工坊皮肤背景图提取补丁（皮肤安装只装背景图，不装皮肤插件）'
function Update-MarketWallpaperPatch {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    Write-Warning "缺少文件: $Path"
    return
  }
  $raw = [IO.File]::ReadAllText($Path)
  if ($raw.Contains('const MARKET_WP_KEY = "dseMarketWallpapers";')) {
    Write-Output "already patched: $Path"
    return
  }
  $anchor = "optional pluginManager service (with the copy-command degradation).`n`t`t*/"
  $helperBlock = @'
		/** Desktop harness: a skin "install" extracts the skin's background
		 *  image into the wallpaper gallery (通用设置 → 壁纸) instead of installing
		 *  the whole skin plugin. The blob lives in the same IndexedDB store the
		 *  aqua wallpaper layer reads; metadata stays in localStorage. */
		const MARKET_WP_KEY = "dseMarketWallpapers";
		function marketWpList() {
			try {
				const raw = window.localStorage.getItem(MARKET_WP_KEY);
				const list = JSON.parse(raw || "[]");
				return Array.isArray(list) ? list : [];
			} catch {
				return [];
			}
		}
		function marketWpSave(list) {
			try {
				window.localStorage.setItem(MARKET_WP_KEY, JSON.stringify(list));
			} catch {}
		}
		function openMarketDb() {
			return new Promise((resolve, reject) => {
				const req = indexedDB.open("dsh-aqua-media", 1);
				req.onupgradeneeded = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains("wallpaper")) db.createObjectStore("wallpaper");
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error || new Error("idb open failed"));
			});
		}
		function marketWpPut(key, blob) {
			return openMarketDb().then((db) => new Promise((resolve, reject) => {
				const tx = db.transaction("wallpaper", "readwrite");
				tx.objectStore("wallpaper").put(blob, key);
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => {
					db.close();
					reject(tx.error);
				};
				tx.onabort = () => {
					db.close();
					reject(tx.error || new Error("idb abort"));
				};
			}));
		}
		async function extractSkinBackground(item) {
			const bg = item.contributes?.backgroundMedia?.light?.src
				|| item.contributes?.backgroundMedia?.dark?.src
				|| item.preview?.light;
			if (!bg) throw new Error("skin has no background media");
			const res = await fetch("https://dsh-market.com/" + bg);
			if (!res.ok) throw new Error("download failed: HTTP " + res.status);
			const blob = await res.blob();
			if (blob.type !== "" && !blob.type.startsWith("image/")) throw new Error("not an image: " + blob.type);
			const id = item.id;
			await marketWpPut("market-skin:" + id, blob);
			const list = marketWpList().filter((entry) => entry.id !== id);
			list.push({ id, name: item.name ?? item.nameEn ?? item.displayName ?? id });
			marketWpSave(list);
		}
'@
  if (-not $raw.Contains($anchor)) {
    Write-Warning "未能匹配市场卡片注释锚点: $Path（可能需要人工检查）"
    return
  }
  $next = $raw.Replace($anchor, $anchor + "`n" + $helperBlock)
  $oldInstalled = 'const installedHere = tab === "skin" ? installed.skins.includes(id) : tab === "pet" ? installed.pets.includes(id) : entryInstalled(item, pluginList ?? []) !== null;'
  $newInstalled = 'const installedHere = tab === "skin" ? installed.skins.includes(id) || marketWpList().some((w) => w.id === id) : tab === "pet" ? installed.pets.includes(id) : entryInstalled(item, pluginList ?? []) !== null;'
  if (-not $next.Contains($oldInstalled)) {
    Write-Warning "未能匹配 installedHere 锚点: $Path（可能需要人工检查）"
    return
  }
  $next = $next.Replace($oldInstalled, $newInstalled)
  $oldInstall = @'
			const onInstallAsset = (kind, id) => {
				if (gateway === null || installing !== null) return;
				installAssetKind(kind, id, false);
			};
'@
  $newInstall = @'
			const onInstallAsset = (kind, id) => {
				if (gateway === null || installing !== null) return;
				if (kind === "skin") {
					onInstallSkinBackground(id);
					return;
				}
				installAssetKind(kind, id, false);
			};
			const onInstallSkinBackground = async (id) => {
				const item = (data?.items?.skin || []).find((entry) => entry.id === id);
				if (!item) return;
				const key = "skin:" + id;
				setInstalling(key);
				try {
					await extractSkinBackground(item);
					setInstalled((prev) => prev.skins.includes(id) ? prev : { ...prev, skins: [...prev.skins, id] });
					callout(id, t("skinBackgroundInstalled"));
				} catch (err) {
					callout(id, t("installFailed", { reason: messageOf(err) }));
				} finally {
					setInstalling(null);
				}
			};
'@
  if (-not $next.Contains($oldInstall)) {
    Write-Warning "未能匹配 onInstallAsset 锚点: $Path（可能需要人工检查）"
    return
  }
  $next = $next.Replace($oldInstall, $newInstall)
  $oldZh = '"installedAt": "安装到 {path}",'
  $newZh = $oldZh + "`n`t`t`t" + '"skinBackgroundInstalled": "背景图已添加到壁纸库（通用设置 → 壁纸）",'
  $oldEn = '"installedAt": "Installed to {path}",'
  $newEn = $oldEn + "`n`t`t`t" + '"skinBackgroundInstalled": "Background added to wallpaper gallery (General settings → Wallpaper)",'
  if (-not $next.Contains($oldZh) -or -not $next.Contains($oldEn)) {
    Write-Warning "未能匹配 locale 锚点: $Path（可能需要人工检查）"
    return
  }
  $next = $next.Replace($oldZh, $newZh).Replace($oldEn, $newEn)
  [IO.File]::WriteAllText($Path, $next)
  Write-Output "patched: $Path"
}
Update-MarketWallpaperPatch (Join-Path $root 'resources\dsh-web-ui\node_modules\@linxin666\dsh-client-ui-market\lib\client.js')

function Update-MarketPackagePatch {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    Write-Warning "缺少文件: $Path"
    return
  }
  $raw = [IO.File]::ReadAllText($Path)
  if ($raw.Contains('"dshDesktopPatch"')) {
    Write-Output "already patched: $Path"
    return
  }
  # Match the top-level version field for any 0.x release so future bumps
  # do not silently break this idempotent patch.
  $match = [regex]::Match($raw, '"version":\s*"0\.\d+\.\d+",')
  if (-not $match.Success) {
    Write-Warning "未能匹配 market package.json 版本锚点: $Path（可能需要人工检查）"
    return
  }
  $anchor = $match.Value
  $next = $raw.Replace($anchor, $anchor + "`n  " + '"dshDesktopPatch": 1,')
  [IO.File]::WriteAllText($Path, $next)
  Write-Output "patched: $Path"
}
Update-MarketPackagePatch (Join-Path $root 'resources\dsh-web-ui\node_modules\@linxin666\dsh-client-ui-market\package.json')

Write-Step '应用目录选择器桌面端委托补丁'
$dpTarget = Join-Path $root 'resources\dsh\node_modules\@deepseek-ai\dsh-host-directory-picker-native\lib\index.js'
if (Test-Path $dpTarget) {
  $dpRaw = [IO.File]::ReadAllText($dpTarget)
  if ($dpRaw.Contains('Desktop shell delegation')) {
    Write-Output "already patched: $dpTarget"
  } else {
    $dpAnchor = "async function pickNativeDirectory(signal, internals = {}) {"
    $dpBodyStart = "`tconst platform = internals.platform ?? process.platform;`r?`n`tconst run = internals.run ?? runNativeCommand;"
    $dpInsert = @'
	// Desktop shell delegation: when DSH_DESKTOP_DIALOG_PORT is set, the
	// Electron main process exposes a loopback /pick endpoint that shows
	// its own native folder dialog — bypassing the Win32 worker spawn that
	// fails inside the packaged Electron runtime.
	const desktopDialogPort = process.env.DSH_DESKTOP_DIALOG_PORT;
	if (desktopDialogPort && platform === "win32") {
		try {
			const url = `http://127.0.0.1:${desktopDialogPort}/pick`;
			const resp = await globalThis.fetch(url, { signal });
			const body = await resp.json();
			if (body.error) throw new Error(body.error);
			return body.path ?? null;
		} catch (fetchError) {
			if (fetchError.code === 'ECONNREFUSED' || fetchError.cause?.code === 'ECONNREFUSED') {
				throw new Error("desktop dialog server is not running; cannot open folder picker");
			}
			throw fetchError;
		}
	}
'@
    $dpInsert = $dpInsert.TrimEnd("`r", "`n")
    $dpNext = $dpRaw.Replace($dpBodyStart, $dpBodyStart + "`n" + $dpInsert)
    if ($dpNext -eq $dpRaw) {
      Write-Warning "未能自动匹配目录选择器补丁位置: $dpTarget（可能需要人工检查）"
    } else {
      [IO.File]::WriteAllText($dpTarget, $dpNext)
      Write-Output "patched: $dpTarget"
    }
  }
} else {
  Write-Warning "缺少文件: $dpTarget"
}

Write-Step '应用工作区卫生规则（standard 预设）'
function Update-WorkspaceHygiene {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    Write-Warning "缺少文件: $Path"
    return
  }
  $raw = [IO.File]::ReadAllText($Path)
  $marker = 'Working-directory hygiene (mandatory)'
  if ($raw.Contains($marker)) {
    Write-Output "already patched: $Path"
    return
  }
  $anchor = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'
  $addition = @'

      Working-directory hygiene (mandatory): never create temporary, auxiliary, diagnostic,
      or intermediate files (logs, scratch scripts, scan reports, backups, encoding/repair
      scripts, build transcripts) inside the user's project/workspace. Keep anything transient
      in the system temp directory and delete it after use. Only write files into the workspace
      when the user explicitly asked for that deliverable. If a build or tool writes artifacts
      into the workspace (e.g. compile logs, scan outputs), redirect them outside the workspace
      or remove them immediately. When files must be left, tell the user exactly which files
      were created and why.
'@
  if (-not $raw.Contains($anchor)) {
    Write-Warning "未找到标准预设锚点: $Path（可能需要人工检查）"
    return
  }
  $next = $raw.Replace($anchor, $anchor + $addition)
  [IO.File]::WriteAllText($Path, $next)
  Write-Output "patched: $Path"
}
Update-WorkspaceHygiene (Join-Path $root 'resources\dsh\node_modules\@deepseek-ai\dsh\config\agent-presets\standard\agent.cordis.yml')

Write-Host "`n完成。接下来可以运行 npm run dist 打包，或 npm start 启动开发版。" -ForegroundColor Green
