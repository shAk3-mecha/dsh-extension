/**
 * dsh-optimizer — host half.
 *
 * Two desktop conveniences in one plugin:
 *   1. One-click restart: arms a one-shot Windows scheduled task that stops the
 *      shell + Host and starts the same executable again (no WMI).
 *   2. Launch window mode: a hidden watcher process, started through the Task
 *      Scheduler so it lives in the interactive desktop session, maximizes the
 *      window — or restores it to the normal 1280x820 size — according to the
 *      mode saved for the *next* launch.
 *
 * The UI is injected into index.html (webserver/index-inject), so it does not
 * depend on the client module loader.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerMini } from './mini.js'

export const name = 'optimizer'
export const inject = ['webServer', 'connection']

const ROUTE_STATE = '/plugins/dsh-optimizer/state'
const ROUTE_MODE = '/plugins/dsh-optimizer/mode'
const ROUTE_RESTART = '/plugins/dsh-optimizer/restart'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const HOME = join(DSH_HOME, 'dsh-optimizer')
const CONFIG = join(HOME, 'config.json')
const WATCHER = join(HOME, 'window-watcher.ps1')
const WATCHER_VBS = join(HOME, 'window-watcher.vbs')
const LOG = join(HOME, 'optimizer.log')
const RESTART_FOLDER = join(tmpdir(), 'dsh-optimizer')
const TASK = 'DSH-Optimizer-Watcher'
const DEFAULT_CONFIG = { mode: 'maximized' }

const RELAUNCH = String.raw`param(
  [Parameter(Mandatory = $true)][int]$HostPid,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Task,
  [Parameter(Mandatory = $true)][string]$Log
)
$ErrorActionPreference = 'SilentlyContinue'
function Write-Log([string]$message) {
  Add-Content -LiteralPath $Log -Value ('{0:HH:mm:ss.fff} relaunch {1}' -f (Get-Date), $message)
}
Write-Log ('begin host=' + $HostPid)
Start-Sleep -Milliseconds 120
$base = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
$folder = [System.IO.Path]::GetDirectoryName($Exe)
# kill the shells first (tree kill, one call) so the host exits normally
& taskkill.exe /F /T /IM ($base + '.exe') | Out-Null
Stop-Process -Id $HostPid -Force
for ($i = 0; $i -lt 60; $i++) {
  if (-not (Get-Process -Name $base -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 80
}
Write-Log 'stopped'
$shell = New-Object -ComObject Shell.Application
for ($attempt = 1; $attempt -le 3; $attempt++) {
  $shell.ShellExecute($Exe, '', $folder, 'open', 1)
  $started = $false
  for ($j = 0; $j -lt 40; $j++) {
    Start-Sleep -Milliseconds 80
    if (Get-Process -Name $base -ErrorAction SilentlyContinue) { $started = $true; break }
  }
  if ($started) { Write-Log ('launched ' + $attempt); break }
}
schtasks /Delete /TN $Task /F | Out-Null
Write-Log 'done'`

function watcherScript() {
  return String.raw`# dsh-optimizer window watcher — launched by the Task Scheduler in the user session.
$ErrorActionPreference = 'SilentlyContinue'
$configPath = '${CONFIG.replace(/'/g, "''")}'
$logPath = '${LOG.replace(/'/g, "''")}'
function Write-Log([string]$message) {
  Add-Content -LiteralPath $logPath -Value ('{0:HH:mm:ss} {1}' -f (Get-Date), $message)
}
$mutex = New-Object System.Threading.Mutex($false, 'Global\DshOptimizerWatcher')
if (-not $mutex.WaitOne(0)) { exit }
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
  }
  public static IntPtr FindWindowForPid(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (pid != target || !IsWindowVisible(hWnd)) return true;
      if (GetWindowTextLength(hWnd) <= 0) return true;
      found = hWnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@
Write-Log 'watcher started'
while ($true) {
  $mode = 'maximized'
  try {
    $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($cfg.mode -eq 'normal') { $mode = 'normal' }
  } catch {}
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  $handle = if ($proc) { $proc.MainWindowHandle } else { [IntPtr]::Zero }
  if ($handle -eq [IntPtr]::Zero) {
    foreach ($candidate in (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
      $h = [DshWin]::FindWindowForPid([uint32]$candidate.Id)
      if ($h -ne [IntPtr]::Zero) { $handle = $h; $proc = $candidate; break }
    }
  }
  if ($handle -ne [IntPtr]::Zero) {
    $placement = New-Object DshWin+WINDOWPLACEMENT
    $placement.length = [System.Runtime.InteropServices.Marshal]::SizeOf($placement)
    [DshWin]::GetWindowPlacement($handle, [ref]$placement) | Out-Null
    Write-Log ('window pid=' + $proc.Id + ' mode=' + $mode + ' showCmd=' + $placement.showCmd)
    if ($mode -eq 'maximized' -and $placement.showCmd -ne 3) {
      [DshWin]::ShowWindow($handle, 3) | Out-Null
      Write-Log 'maximized'
    }
    if ($mode -eq 'normal' -and $placement.showCmd -eq 3) {
      [DshWin]::ShowWindow($handle, 9) | Out-Null
      Write-Log 'restored'
    }
    $control = '${join(HOME, 'window-control.ps1').replace(/'/g, "''")}'
    while (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
      if ([DshWin]::IsIconic($handle)) {
        & $control -Action enter
        Start-Sleep -Seconds 1
      }
      Start-Sleep -Milliseconds 400
    }
    Write-Log 'app exited'
  }
  Start-Sleep -Seconds 2
}
`
}

function logLine(text) {
  try {
    mkdirSync(HOME, { recursive: true })
    appendFileSync(LOG, `${new Date().toISOString()} host ${text}\n`)
  } catch {}
}

function readConfig() {
  try {
    const value = JSON.parse(readFileSync(CONFIG, 'utf8'))
    return value.mode === 'normal' ? { mode: 'normal' } : { mode: 'maximized' }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function writeConfig(config) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => resolve({ code: -1, out, err: String(error) }))
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }))
  })
}

function capability() {
  const exe = process.execPath
  const desktop = process.platform === 'win32' && typeof process.versions.electron === 'string' && /\.exe$/iu.test(exe)
  return { supported: desktop, platform: process.platform }
}

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

async function ensureWatcher() {
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(WATCHER, watcherScript(), 'utf8')
    if (!existsSync(CONFIG)) writeConfig(readConfig())
  } catch (error) {
    logLine(`watcher write failed: ${String(error)}`)
    return
  }
  try {
    writeFileSync(WATCHER_VBS, [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "${POWERSHELL} -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${WATCHER}""", 0, False`,
      '',
    ].join('\r\n'), 'utf8')
  } catch (error) {
    logLine(`watcher vbs write failed: ${String(error)}`)
    return
  }
  // Recreate the task so a host upgrade also replaces an old command line.
  await run('schtasks.exe', ['/Delete', '/TN', TASK, '/F'])
  const created = await run('schtasks.exe', ['/Create', '/TN', TASK, '/TR', `wscript.exe "${WATCHER_VBS}"`, '/SC', 'ONCE', '/SD', '2030/12/31', '/ST', '23:59', '/F'])
  if (created.code !== 0) {
    logLine(`watcher task create failed: ${created.err || created.out}`)
    return
  }
  const started = await run('schtasks.exe', ['/Run', '/TN', TASK])
  if (started.code !== 0) logLine(`watcher run: ${started.err || started.out}`)
}

export async function startRelaunch() {
  const exe = process.execPath
  const hostPid = process.pid
  const stamp = `${hostPid}-${Date.now()}`
  const task = `dsh-optimizer-restart-${stamp}`
  const script = join(RESTART_FOLDER, `relaunch-${stamp}.ps1`)
  const wrapper = join(RESTART_FOLDER, `run-${stamp}.vbs`)
  const log = join(RESTART_FOLDER, 'restart.log')

  try {
    mkdirSync(RESTART_FOLDER, { recursive: true })
    writeFileSync(script, RELAUNCH, 'utf8')
    writeFileSync(
      wrapper,
      [
        'Set sh = CreateObject("WScript.Shell")',
        `sh.Run "${POWERSHELL} -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${script}"" ${hostPid} ""${exe}"" ""${task}"" ""${log}""", 0, False`,
        '',
      ].join('\r\n'),
      'utf8',
    )
  } catch (error) {
    return { ok: false, detail: `write failed: ${String(error)}` }
  }

  const tr = `wscript.exe "${wrapper}"`
  let created = await run('schtasks.exe', ['/Create', '/TN', task, '/TR', tr, '/SC', 'ONCE', '/SD', '2030/12/31', '/ST', '23:59', '/F'])
  if (created.code !== 0) {
    created = await run('schtasks.exe', ['/Create', '/TN', task, '/TR', tr, '/SC', 'ONCE', '/ST', '23:59', '/F'])
  }
  if (created.code !== 0) return { ok: false, detail: `schtasks create failed: ${created.err || created.out}` }
  const started = await run('schtasks.exe', ['/Run', '/TN', task])
  if (started.code !== 0) {
    await run('schtasks.exe', ['/Delete', '/TN', task, '/F'])
    return { ok: false, detail: `schtasks run failed: ${started.err || started.out}` }
  }
  return { ok: true, task }
}

const INJECT_SCRIPT = `(function () {
  if (window.__dshOptimizerMounted) return;
  window.__dshOptimizerMounted = true;

  var stateUrl = '/plugins/dsh-optimizer/state';
  var modeUrl = '/plugins/dsh-optimizer/mode';
  var restartUrl = '/plugins/dsh-optimizer/restart';
  var miniEnter = '/plugins/dsh-optimizer/mini/enter';
  var miniExit = '/plugins/dsh-optimizer/mini/exit';
  var skinSaved;
  var suppressUntil = 0;

  function style() {
    if (document.getElementById('dsh-optimizer-style')) return;
    var s = document.createElement('style');
    s.id = 'dsh-optimizer-style';
    s.textContent = [
      '#dsh-optimizer-bar{position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483000;display:inline-flex;gap:6px;-webkit-app-region:no-drag}',
      '#dsh-optimizer-bar button{height:26px;padding:0 12px;border-radius:6px;border:1px solid rgba(255,122,26,.30);background:#fffdf5;color:#332b1f;font:600 12px/1 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;cursor:pointer;box-shadow:0 1px 2px rgba(88,70,45,.14)}',
      '#dsh-optimizer-bar button:hover{background:#fff4cc}',
      'html[data-dsh-mini] #dsh-optimizer-bar{display:none!important}',

      'html[data-dsh-mini]{background:#fffdf2!important}',
      'html[data-dsh-mini] body{overflow:hidden!important;background:#fffdf2!important;color:#332b1f!important;--dsw-alias-label-primary:#332b1f!important;--dsw-alias-label-secondary:#5d5240!important;--dsw-alias-label-tertiary:#7a6c55!important;--dsw-alias-label-caption:#8a7a61!important;--dsw-alias-bg-base:#fdf8e3!important;--dsw-alias-bg-layer-1:#fffdf5!important;--dsw-alias-bg-layer-2:#fffef9!important;--dsw-alias-bg-layer-3:#fff4cc!important;--dsw-alias-border-l1:rgba(255,122,26,.14)!important;--dsw-alias-border-l2:rgba(255,122,26,.22)!important;--dsw-alias-border-l3:rgba(255,122,26,.30)!important;--dsw-alias-border-l4:rgba(255,122,26,.38)!important;--dsw-alias-markdown-code-block:#f3e9d8!important;--dsw-alias-markdown-code-block-banner:#fffdf5!important;--dsw-alias-interactive-bg-hover:rgba(160,107,42,.10)!important;--dsw-specific-input-major:#fffef9!important;--dsw-specific-bubble:#f3e9d8!important;--dsw-specific-menu:#fffef9!important;--dsw-specific-selector:#fff4cc!important}',
      'html[data-dsh-mini] *{scrollbar-width:none}',
      'html[data-dsh-mini] *::-webkit-scrollbar{display:none!important;width:0;height:0}',
      'html[data-dsh-mini] [data-slot="sidebar"],html[data-dsh-mini] [data-sidebar-right-panel],html[data-dsh-mini] [data-conversation-header]{display:none!important}',
      'html[data-dsh-mini] [data-conversation-region] :where(p,li,div,span,pre,code,strong,em,td,th,a,button){font-size:10px!important;line-height:1.3!important}',
      'html[data-dsh-mini] [data-conversation-region] :where(h1,h2,h3,h4,h5){font-size:12px!important;line-height:1.25!important}',
      'html[data-dsh-mini] [data-composer-card] :where(div,span,textarea,p,button){font-size:10px!important;line-height:1.3!important}',

      '#dsh-mini-grid{position:fixed;inset:0;z-index:500;display:none;padding:1px;gap:1px;background:#fdf6da;grid-template-columns:1fr;grid-template-rows:28px 1fr 84px}',
      'html[data-dsh-mini] #dsh-mini-grid{display:grid}',
      '.mbox{background:#fffdf5;border:1px solid rgba(255,122,26,.22);border-radius:0;min-width:0;min-height:0}',
      '#mini-task{grid-row:1;display:flex;align-items:center;gap:8px;padding:0 190px 0 10px;font:10px/1.2 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;color:#4a3f2e;background:#fffdf5;border:1px solid rgba(255,122,26,.22)}',
      '#mini-task .dot{width:7px;height:7px;border-radius:50%;background:#4e8f3d;flex:none}',
      '#mini-task .dot[data-running="1"]{background:#4e8f3d;animation:dp 1s infinite}',
      '@keyframes dp{50%{opacity:.35}}',
      '#mini-task .task{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#4a3f2e}',
      '#mini-task .perm{cursor:pointer;border:1px solid rgba(255,122,26,.26);border-radius:4px;padding:2px 8px;color:#6b5d48;background:#fff4cc;white-space:nowrap}',
      '#mini-task .perm b{color:#ff5a1f;font-weight:700}',
      '#mini-task .restore{height:18px;padding:0 8px;border:1px solid rgba(255,122,26,.30);border-radius:4px;background:#fff4cc;color:#4a3f2e;font-size:10px;cursor:pointer}',
      '#mini-task{-webkit-app-region:drag}',
      '#mini-task .perm,#mini-task .restore{-webkit-app-region:no-drag}',
      'html[data-dsh-mini] *{background-image:none!important}',
      '#mini-chat{grid-row:2;overflow:hidden}',
      'html[data-dsh-mini] [data-composer-card] img,html[data-dsh-mini] [data-composer-card] [class*="preview"],html[data-dsh-mini] [data-composer-card] [class*="attachment"]{display:none!important}',
      'html[data-dsh-mini] [data-conversation-region] img{max-height:68px!important;max-width:38%!important;width:auto!important;object-fit:cover!important;float:left!important;margin:2px 8px 2px 0!important;border-radius:4px}',
      'html[data-dsh-mini] [data-composer-card] img{max-height:40px!important;max-width:56px!important;width:auto!important;object-fit:cover!important;float:left!important;margin:0 6px 0 0!important;border-radius:4px}',
      'html[data-dsh-mini] [data-composer-card] [class*="attach"],html[data-dsh-mini] [data-composer-card] [data-attachment]{max-height:46px!important;overflow:hidden!important;float:left!important}',
      'html[data-dsh-mini] [data-composer-card] textarea{min-height:34px!important;max-height:52px!important;font-size:10px!important}',
      'html[data-dsh-approval] #mini-task,html[data-dsh-approval] #mini-composer{display:none!important}',
      'html[data-dsh-approval] #mini-chat{grid-row:1 / 4!important}',
      'html[data-dsh-mini] [data-usage-state="dock"]{display:none!important}',
      'html[data-dsh-mini] [role="dialog"]{max-height:calc(100% - 12px)!important;overflow:auto!important}',
      '#mini-bal{color:#ff5a1f;font-weight:600}',
      '.dsh-mini-approval{position:fixed!important;left:2px!important;right:2px!important;top:2px!important;bottom:2px!important;z-index:700!important;background:#fffdf5!important;border:1px solid rgba(255,122,26,.30)!important;padding:12px!important;overflow:auto!important;max-height:none!important;border-radius:0!important;color:#332b1f!important}',
      '#mini-composer{grid-row:3;overflow:visible}'
    ].join('');
    document.head.appendChild(s);
  }

  function box(id, cls, html) {
    var d = document.createElement('div');
    d.id = id;
    if (cls) d.className = cls;
    if (html) d.innerHTML = html;
    return d;
  }

  function ensureGrid() {
    style();
    if (document.getElementById('dsh-mini-grid')) return;
    var g = document.createElement('div');
    g.id = 'dsh-mini-grid';
    var task = box('mini-task', '', '<span class="dot" id="mini-dot"></span><span class="task" id="mini-task-text">当前任务</span>'
      + '<span class="perm" id="mini-perm">权限 <b id="mini-perm-value">工作区内修改</b></span>'
      + '<button class="restore" id="mini-exit" type="button">还原</button>');
    var chat = box('mini-chat', 'mbox', '');
    var comp = box('mini-composer', 'mbox', '');
    g.appendChild(task);
    g.appendChild(chat);
    g.appendChild(comp);
    document.body.appendChild(g);
    document.getElementById('mini-exit').onclick = exitMini;
    document.getElementById('mini-perm').onclick = togglePermission;
  }

  function layout() {
    if (!document.documentElement.hasAttribute('data-dsh-mini')) return;
    var chat = document.querySelector('[data-conversation-region]');
    var comp = document.querySelector('[data-composer-card]');
    var cf = document.getElementById('mini-chat');
    var pf = document.getElementById('mini-composer');
    if (!chat || !comp || !cf || !pf) return;
    var approval = document.documentElement.hasAttribute('data-dsh-approval');
    var r = approval ? { left: 1, top: 23, width: window.innerWidth - 2, height: window.innerHeight - 24 } : cf.getBoundingClientRect();
    chat.style.position = 'fixed';
    chat.style.left = r.left + 'px';
    chat.style.top = r.top + 'px';
    chat.style.width = r.width + 'px';
    chat.style.height = r.height + 'px';
    chat.style.zIndex = '600';
    chat.style.overflow = 'auto';
    chat.style.overflowX = 'hidden';
    chat.style.padding = '6px 8px';
    chat.style.boxSizing = 'border-box';
    chat.style.background = 'transparent';
    chat.style.border = '0';
    chat.style.color = '#332b1f';
    chat.style.fontSize = '9.5px';
    chat.style.lineHeight = '1.25';
    var q = approval ? { left: 1, top: window.innerHeight, width: 0, height: 0 } : pf.getBoundingClientRect();
    comp.style.position = 'fixed';
    comp.style.left = q.left + 'px';
    comp.style.top = q.top + 'px';
    comp.style.width = q.width + 'px';
    comp.style.height = q.height + 'px';
    comp.style.zIndex = '600';
    comp.style.margin = '0';
    comp.style.boxSizing = 'border-box';
    comp.style.overflow = 'visible';
    comp.style.background = 'transparent';
    comp.style.border = '0';
    if (approval) chat.scrollTop = 0;
  }

  function setMini(on) {
    if (on) {
      if (skinSaved === undefined) skinSaved = document.documentElement.getAttribute('data-dsh-skin');
      if (skinSaved !== null) document.documentElement.removeAttribute('data-dsh-skin');
      ensureGrid();
      document.documentElement.setAttribute('data-dsh-mini', '1');
      hideMenuBar();
      refresh();
      layout();
      setTimeout(layout, 80);
      setTimeout(layout, 400);
      paintToggle();
    } else {
      document.documentElement.removeAttribute('data-dsh-mini');
      [document.querySelector('[data-conversation-region]'), document.querySelector('[data-composer-card]')].forEach(function (el) {
        if (!el) return;
        ['position', 'left', 'top', 'width', 'height', 'zIndex', 'overflow', 'overflowX', 'padding', 'boxSizing', 'background', 'border', 'color', 'fontSize', 'margin'].forEach(function (k) {
          el.style[k] = '';
        });
      });
      if (skinSaved !== undefined && skinSaved !== null) document.documentElement.setAttribute('data-dsh-skin', skinSaved);
      skinSaved = undefined;
      paintToggle();
    }
  }

  function enterMini() {
    fetch(miniEnter, { method: 'POST', credentials: 'same-origin' }).then(function () { setMini(true); }).catch(function () {});
  }
  function exitMini() {
    suppressUntil = Date.now() + 8000;
    setMini(false);
    fetch(miniExit, { method: 'POST', credentials: 'same-origin' }).catch(function () {});
  }

  function refresh() {
    if (!document.documentElement.hasAttribute('data-dsh-mini')) return;
    var header = document.querySelector('[data-conversation-header]');
    var title = header ? (header.textContent || '').trim().split('\\n')[0] : '';
    var task = document.getElementById('mini-task-text');
    var dot = document.getElementById('mini-dot');
    if (task) task.textContent = title || '对话';
    if (dot) dot.setAttribute('data-running', document.querySelector('[data-chat-running],[data-turn-process]') ? '1' : '0');
    var dock = document.querySelector('[data-usage-state="dock"]');
    var bal = dock ? ((dock.textContent || '').match(/¥\s*([0-9][0-9.,]*)/) || [])[1] : null;
    var holder = null;
    var best = 1e9;
    var nodes = document.querySelectorAll('[data-conversation-region] *, [data-composer-card] *');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var text = el.textContent || '';
      if (text.indexOf('缓存命中') < 0) continue;
      if (text.length < best) { best = text.length; holder = el; }
    }
    if (holder) {
      var mark = document.getElementById('mini-bal');
      if (!mark) { mark = document.createElement('span'); mark.id = 'mini-bal'; }
      mark.textContent = bal ? ('¥' + bal + ' · ') : '';
      if (mark.parentNode !== holder || holder.firstChild !== mark) holder.insertBefore(mark, holder.firstChild);
    }
    fitApproval();
    var pv = document.getElementById('mini-perm-value');
    var p = document.querySelector('[data-slot="conversation.input.permission"]');
    if (pv && p) pv.textContent = /完全/.test(p.textContent || '') ? '完全权限' : '工作区内修改';
    layout();
  }

  function shortenPaths() {}

  function fitApproval() {
    var buttons = document.querySelectorAll('button');
    var pending = false;
    for (var i = 0; i < buttons.length; i++) {
      var text = buttons[i].textContent || '';
      if (/允许一次|允许|批准/.test(text) || /拒绝/.test(text)) { pending = true; break; }
    }
    var flagged = document.documentElement.hasAttribute('data-dsh-approval');
    if (pending && !flagged) {
      document.documentElement.setAttribute('data-dsh-approval', '1');
      layout();
    } else if (pending) {
      shortenPaths();
    } else if (!pending && flagged) {
      document.documentElement.removeAttribute('data-dsh-approval');
      layout();
    }
  }

  function hideMenuBar() {
    var menu = document.querySelector('[role="menubar"]');
    if (!menu) {
      var nodes = document.querySelectorAll('body *');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.children.length > 6) continue;
        var text = (el.textContent || '').replace(/\\s+/g, '');
        if (text.indexOf('应用') < 0 || text.indexOf('编辑') < 0) continue;
        var rect = el.getBoundingClientRect();
        if (rect.height > 0 && rect.height < 48) { menu = el; break; }
      }
    }
    if (!menu) return;
    menu.style.fontSize = '9px';
    menu.style.lineHeight = '1.2';
    var kids = menu.querySelectorAll('*');
    for (var k = 0; k < kids.length; k++) {
      kids[k].style.fontSize = '9px';
      kids[k].style.lineHeight = '1.2';
    }
  }

  function togglePermission() {
    var sel = document.querySelector('[data-slot="conversation.input.permission"]');
    if (!sel) return;
    var target = /完全/.test(sel.textContent || '') ? '工作区内修改' : '完全权限';
    sel.click();
    setTimeout(function () {
      var items = Array.prototype.slice.call(document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],button'));
      var hit = items.filter(function (el) { return (el.textContent || '').indexOf(target) >= 0; })[0];
      if (hit) hit.click();
      setTimeout(function () {
        var ok = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (el) { return /启用完全权限|确认/.test(el.textContent || ''); })[0];
        if (ok) ok.click();
        setTimeout(refresh, 300);
      }, 300);
    }, 250);
  }

  function mountBar() {
    if (document.getElementById('dsh-optimizer-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'dsh-optimizer-bar';
    bar.innerHTML = '<button id="dsh-op-restart" type="button">\\u21bb \\u91cd\\u542f DSH</button>'
      + '<button id="dsh-op-mode" type="button">\\u4e0b\\u6b21\\u6253\\u5f00\\uff1a<span class="mode">\\u5168\\u5c4f</span></button>'
      + '<button id="dsh-op-mini" type="button">\\u6781\\u7b80</button>';
    document.body.appendChild(bar);
    var mode = 'maximized';
    var modeSpan = bar.querySelector('.mode');
    function paintMode() { if (modeSpan) modeSpan.textContent = mode === 'maximized' ? '\\u5168\\u5c4f' : '\\u5c0f\\u7a97\\u53e3'; }
    fetch(stateUrl, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (i) { if (i && i.mode === 'normal') mode = 'normal'; paintMode(); }).catch(function () { paintMode(); });
    document.getElementById('dsh-op-restart').onclick = function () {
      if (!window.confirm('\\u91cd\\u542f DeepSeek Harness\\uff1f\\n\\n\\u6b63\\u5728\\u8fd0\\u884c\\u7684\\u4efb\\u52a1\\u4f1a\\u88ab\\u4e2d\\u65ad\\u3002')) return;
      fetch(restartUrl, { method: 'POST', credentials: 'same-origin' }).catch(function () {});
    };
    document.getElementById('dsh-op-mode').onclick = function () {
      mode = mode === 'maximized' ? 'normal' : 'maximized';
      paintMode();
      fetch(modeUrl, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: mode }) }).catch(function () {});
    };
    document.getElementById('dsh-op-mini').onclick = function () {
      if (document.documentElement.hasAttribute('data-dsh-mini')) exitMini(); else enterMini();
    };
    paintToggle();
  }

  function paintToggle() {
    var b = document.getElementById('dsh-op-mini');
    if (b) b.textContent = document.documentElement.hasAttribute('data-dsh-mini') ? '\\u8fd8\\u539f\\u6781\\u7b80' : '\\u6781\\u7b80';
  }

  function mount() {
    style();
    mountBar();
    setInterval(function () {
      if (document.documentElement.hasAttribute('data-dsh-mini')) { refresh(); hideMenuBar(); }
      if (window.innerWidth <= 760 && Date.now() > suppressUntil && !document.documentElement.hasAttribute('data-dsh-mini')) setMini(true);
      if (window.innerWidth > 860 && document.documentElement.hasAttribute('data-dsh-mini')) setMini(false);
    }, 1200);
    window.addEventListener('resize', function () { setTimeout(layout, 60); });
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  window.__dshOptimizerSetMini = setMini;
  window.__dshOptimizerEnterMini = enterMini;
})();`

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 8192) { resolve(null); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

export function apply(ctx) {
  let restarting = false
  ensureWatcher().catch((error) => logLine(`watcher start failed: ${String(error)}`))
  try {
    registerMini(ctx, { HOME, POWERSHELL, run, logLine })
  } catch (error) {
    logLine(`mini register failed: ${String(error)}`)
  }

  ctx.on('webserver/index-inject', (table) => {
    try {
      if (Array.isArray(table)) { table.push({ kind: 'script', placement: 'body', text: INJECT_SCRIPT }); logLine('inject rows=' + table.length) }
    } catch (error) {
      ctx.logger?.warn?.('dsh-optimizer: index injection failed: %s', String(error))
    }
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_STATE,
    handler: (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) return
      json(res, 200, { ...capability(), mode: readConfig().mode })
    },
  }), 'dsh-optimizer: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_MODE,
    handler: async (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) return
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const body = await readBody(req)
      const mode = body?.mode === 'normal' ? 'normal' : 'maximized'
      writeConfig({ mode })
      logLine(`mode=${mode}`)
      ensureWatcher().catch(() => {})
      json(res, 200, { ok: true, mode })
    },
  }), 'dsh-optimizer: mode route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_RESTART,
    handler: (req, res) => {
      logLine('restart request method=' + (req.method ?? '') + ' supported=' + capability().supported)
      if (!ctx.connection.authorizeIndex(req, res)) return
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      if (!capability().supported) { logLine('restart unsupported'); json(res, 409, { ok: false, error: '只在 Windows 桌面端可用。' }); return }
      if (restarting) { json(res, 429, { ok: false, error: '重启已在进行中' }); return }
      restarting = true
      startRelaunch().then((result) => {
        if (result.ok) {
          json(res, 202, { ok: true, task: result.task })
          logLine(`restart task=${result.task}`)
        } else {
          restarting = false
          json(res, 500, { ok: false, error: result.detail ?? '重启任务创建失败' })
          logLine(`restart failed: ${result.detail}`)
        }
      })
    },
  }), 'dsh-optimizer: restart route')
}


