param([string]$Root = '')

# Plan A installer - no Python required. Windows PowerShell 5.1+ / PowerShell 7+
# This file is UTF-8 WITH BOM on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [Text.Encoding]::UTF8

$pkg = $PSScriptRoot
$UTF8NoBom = New-Object System.Text.UTF8Encoding($false)
$UTF8Strict = New-Object System.Text.UTF8Encoding($false, $true)   # 严格模式，用来判断是否真是 UTF-8
$UTF8WithBom = New-Object System.Text.UTF8Encoding($true)
$LINE = '<script src="y3/embed.js"></script>'
$ANCHOR = '<script src="admin.js"></script>'
$STAMP = Get-Date -Format 'yyyyMMdd_HHmmss'

function Say($s) { Write-Host $s }
function Ok($s) { Write-Host ('  [OK] ' + $s) -ForegroundColor Green }
function Bad($s) { Write-Host ('  [!!] ' + $s) -ForegroundColor Red }
function Warn($s) { Write-Host ('  [--] ' + $s) -ForegroundColor Yellow }

Say ''
Say '=================================================================='
Say ' 方案 A · 新增「果实编辑器（Y3版）」测试页签'
Say ' 原「果实管理」与整个后台保持不变'
Say '=================================================================='

# ---------- 探测项目根：兼容「把包内容放进项目根」和「把整个文件夹放进项目根」两种摆法 ----------
$cands = @()
if ($Root) { $cands += $Root }
$cands += $pkg
$cands += (Split-Path $pkg -Parent)
$parent = Split-Path $pkg -Parent
if ($parent) { $cands += (Split-Path $parent -Parent) }

$root = $null
foreach ($c in $cands) {
  if (-not $c) { continue }
  if ((Test-Path (Join-Path $c 'admin.html')) -and
      (Test-Path (Join-Path $c 'admin.js')) -and
      (Test-Path (Join-Path $c 'admin.css'))) {
    $root = (Resolve-Path $c).Path
    break
  }
}
if (-not $root) {
  Bad '没有找到项目根目录（需要同时存在 admin.html / admin.js / admin.css）。'
  Say ''
  Say '  请把本文件夹里的【全部内容】复制到项目根目录，例如：'
  Say '    <项目根>\admin.html'
  Say '    <项目根>\安装.bat'
  Say '    <项目根>\y3\ ...'
  Say '  然后重新双击 安装.bat。'
  Say '  （也可以把项目根路径作为参数传进来：install.ps1 "D:\你的项目"）'
  exit 1
}
Say ('项目根：' + $root)
Say ('包目录：' + $pkg)
Say ''

$admin = Join-Path $root 'admin.html'
$raw = [IO.File]::ReadAllBytes($admin)

# 编码自适应：用户可能在 Windows 记事本里把 admin.html 存成 GBK/ANSI。
# 若按 UTF-8 强行解码再写回，会把整个文件写坏，所以先严格校验、失败则回退 GBK，
# 并记住原编码，写回时用同一套编码 + 同样的 BOM 状态。
$hasBom = ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF)
$body = if ($hasBom) { [byte[]]$raw[3..($raw.Length - 1)] } else { $raw }
$encWrite = if ($hasBom) { $UTF8WithBom } else { $UTF8NoBom }
try {
  $text = $UTF8Strict.GetString($body)
} catch {
  $gbk = [Text.Encoding]::GetEncoding(936)
  $text = $gbk.GetString($body)
  $encWrite = $gbk
  Warn 'admin.html 不是 UTF-8，已按 GBK 读取，并会用 GBK 原样写回（编码保持不变）'
}
$nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
$beforeLines = ($text -split "`r?`n").Count

# ---------- 1. 备份 ----------
$bak = Join-Path $root ('admin.html.bak_PlanA_' + $STAMP)
Copy-Item -LiteralPath $admin -Destination $bak -Force
Ok ('已备份 → ' + (Split-Path $bak -Leaf))

# ---------- 2. 插入 1 行 ----------
$changed = $false
if ($text.Contains('y3/embed.js')) {
  Warn '检测到已存在 Y3 引用，跳过插入（不会重复添加）'
} else {
  if (-not $text.Contains($ANCHOR)) {
    Bad '找不到锚点 <script src="admin.js"></script>。'
    Say ('  请手动在 </body> 前加一行：' + $LINE)
    Say '  已创建的备份可直接覆盖回去。'
    exit 1
  }
  $newText = $text.Replace($ANCHOR, $ANCHOR + $nl + $LINE)
  [IO.File]::WriteAllText($admin, $newText, $encWrite)
  $changed = $true
  $afterLines = ($newText -split "`r?`n").Count
  Ok ('已插入 1 行：' + $LINE + '   （行数 ' + $beforeLines + ' → ' + $afterLines + '）')
  if (($afterLines - $beforeLines) -ne 1) { Bad '净增行数不是 1，请检查文件'; exit 1 }
}

# ---------- 3. 部署 y3/ ----------
$srcY3 = Join-Path $pkg 'y3'
$dstY3 = Join-Path $root 'y3'
if (-not (Test-Path $srcY3)) { Bad ('包内缺少 y3 目录：' + $srcY3); exit 1 }
if (Test-Path $dstY3) {
  $oldName = 'y3.bak_PlanA_' + $STAMP
  Rename-Item -LiteralPath $dstY3 -NewName $oldName
  Warn ('旧 y3/ 已备份 → ' + $oldName)
}
Copy-Item -LiteralPath $srcY3 -Destination $dstY3 -Recurse -Force
Ok ('已部署 y3/（' + ((Get-ChildItem -LiteralPath $dstY3 -File).Count) + ' 个文件）')

# ---------- 4. 静态验收 ----------
Say ''
Say '[静态验收]'
$now = $encWrite.GetString([IO.File]::ReadAllBytes($admin))
$old = $encWrite.GetString([IO.File]::ReadAllBytes($bak))
if ($changed) {
  $restored = $now.Replace($nl + $LINE, '')
  if ($restored -eq $old) { Ok 'admin.html 除新增 1 行外，与原文件逐字一致' }
  else { Bad 'admin.html 出现了额外改动！请用备份回滚' }
} else {
  if ($now.Contains('y3/embed.js')) { Ok 'admin.html 已包含 Y3 引用' } else { Bad '引用缺失' }
}
Ok 'admin.js / admin.css 未被本安装器改动（包内不含这两个文件）'

$need = @('embed.js','embed.css','index.html','editor.css','editor.js','语句树_schema.js','果实库.js')
foreach ($f in $need) {
  if (Test-Path (Join-Path $dstY3 $f)) { Ok ('y3/' + $f + ' 存在') }
  else { Bad ('缺少 y3/' + $f) }
}

# 安装.bat 必须纯 ASCII，否则 cmd 会再次错位
$batBytes = [IO.File]::ReadAllBytes((Join-Path $pkg '安装.bat'))
$nonAscii = @($batBytes | Where-Object { $_ -gt 127 }).Count
if ($nonAscii -eq 0) { Ok '安装.bat 为纯 ASCII（不会触发 cmd/GBK 解析错位）' }
else { Bad ('安装.bat 含 ' + $nonAscii + ' 个非 ASCII 字节，请重新解压本包') }

$emb = $UTF8NoBom.GetString([IO.File]::ReadAllBytes((Join-Path $dstY3 'embed.js')))
if ($emb.Contains('isolated=1&embed=1')) { Ok 'iframe 以 isolated=1&embed=1 加载（数据隔离）' }
else { Bad 'iframe 隔离参数缺失' }
$edjs = $UTF8NoBom.GetString([IO.File]::ReadAllBytes((Join-Path $dstY3 'editor.js')))
if ($edjs.Contains("'wowpinball.y3.test.v1'")) { Ok 'Y3 使用独立 key wowpinball.y3.test.v1' }
else { Bad '独立 key 缺失' }

Say ''
Say '=================================================================='
Ok '安装完成。'
Say '=================================================================='
Say ''
Say '下一步：'
Say '  1. 先访问 http://127.0.0.1:8787/y3/index.html?isolated=1&embed=1'
Say '     能看到编辑器 → 静态目录 OK；若 404，给 server.js 加 /y3/ 静态放行。'
Say '  2. 回到 http://127.0.0.1:8787/admin.html ，按 Ctrl+F5 强制刷新。'
Say '  3. 左侧「果实管理」下面会多出「果实编辑器 · Y3版 [TEST]」。'
Say '  4. 想直接进测试页：admin.html?y3=1'
Say ''
Say '  原「果实管理」完全保留；Y3 里的编辑只写独立测试数据，'
Say '  不会写入 data/game-config.json。'
Say '  回滚：双击 卸载_回滚.bat'
Say ''
