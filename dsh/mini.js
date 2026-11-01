/**
 * dsh-extension — mini mode.
 *
 * A dedicated compact surface, not a scaled copy of the main UI: the real
 * conversation stays in place (so messages, approvals and the composer keep
 * working), while the sidebar, header and side panels are removed and replaced
 * by a thin task strip on top and a stats strip at the bottom. Entering mini
 * mode also shrinks the native window to a small always-on-top panel.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SIZE = { width: 625, height: 272, margin: 12 }

function psString(value) {
  return String(value).replace(/'/g, "''")
}

function windowScript(home) {
  const state = psString(join(home, 'mini-window.json'))
  return String.raw`param([Parameter(Mandatory = $true)][string]$Action)
$ErrorActionPreference = 'SilentlyContinue'
$statePath = '${state}'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshMini {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetMenu(IntPtr hWnd, IntPtr hMenu);
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static IntPtr Find(uint target) {
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

$hwnd = [IntPtr]::Zero
foreach ($p in (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
  $h = [DshMini]::Find([uint32]$p.Id)
  if ($h -ne [IntPtr]::Zero) { $hwnd = $h; break }
}
if ($hwnd -eq [IntPtr]::Zero) { exit 1 }

if ($Action -eq 'enter') {
  $rect = New-Object DshMini+RECT
  [DshMini]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  if (($rect.Right - $rect.Left) -gt 700) {
    $menuHandle = [DshMini]::GetMenu($hwnd)
    @{ x = $rect.Left; y = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top); menu = [int64]$menuHandle } |
      ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
  }
  [DshMini]::ShowWindow($hwnd, 9) | Out-Null
  # drop the native app menu bar while the window is in mini mode
  [DshMini]::SetMenu($hwnd, [IntPtr]::Zero) | Out-Null
  Add-Type -AssemblyName System.Windows.Forms
  $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $x = $work.Right - ${SIZE.width} - ${SIZE.margin}
  $y = $work.Bottom - ${SIZE.height} - ${SIZE.margin}
  # HWND_TOPMOST = -1, SWP_SHOWWINDOW = 0x40
  [DshMini]::SetWindowPos($hwnd, [IntPtr](-1), $x, $y, ${SIZE.width}, ${SIZE.height}, 0x40) | Out-Null
} else {
  $restore = $null
  try { $restore = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch {}
  if ($restore -ne $null -and $restore.width -gt 0) {
    [DshMini]::SetWindowPos($hwnd, [IntPtr](-2), [int]$restore.x, [int]$restore.y, [int]$restore.width, [int]$restore.height, 0x40) | Out-Null
    if ($restore.menu -ne $null -and [int64]$restore.menu -ne 0) {
      [DshMini]::SetMenu($hwnd, [IntPtr][int64]$restore.menu) | Out-Null
    }
  } else {
    [DshMini]::ShowWindow($hwnd, 3) | Out-Null
  }
  Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
}
`
}

function watchScript(home) {
  return String.raw`$ErrorActionPreference = 'SilentlyContinue'
$control = '${psString(join(home, 'window-control.ps1'))}'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshMiniWatch {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$mutex = New-Object System.Threading.Mutex($false, 'Global\DshOptimizerMiniWatch')
if (-not $mutex.WaitOne(0)) { exit }
while ($true) {
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc -and [DshMiniWatch]::IsIconic($proc.MainWindowHandle)) {
    & '$control' -Action enter
    Start-Sleep -Seconds 1
  }
  Start-Sleep -Milliseconds 450
}
`
}

const MINI_INJECT = `(function () {
  if (window.__dshOptimizerMini) return;
  window.__dshOptimizerMini = true;
  var enterUrl = '/plugins/dsh-extension/mini/enter';
  var exitUrl = '/plugins/dsh-extension/mini/exit';
  var stateUrl = '/plugins/dsh-extension/mini/state';

  function style() {
    if (document.getElementById('dsh-mini-style')) return;
    var s = document.createElement('style');
    s.id = 'dsh-mini-style';
    s.textContent = [
      '#dsh-mini-shell{position:fixed;inset:0;z-index:2147482000;display:none;background:radial-gradient(120% 80% at 50% 0%,#1b2230 0%,#0b0d12 62%,#08090d 100%)}',
      'html[data-dsh-mini] #dsh-mini-shell{display:block}',
      'html[data-dsh-mini] [data-slot="sidebar"],html[data-dsh-mini] [data-sidebar-right-panel],html[data-dsh-mini] [data-conversation-header]{display:none!important}',
      'html[data-dsh-mini] [data-conversation-region]{position:fixed!important;top:42px;bottom:164px;left:12px;right:12px;z-index:2147482400;overflow:auto;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px 12px}',
      'html[data-dsh-mini] [data-composer-card]{position:fixed!important;left:12px;right:12px;bottom:48px;z-index:2147482400;margin:0!important;width:auto!important;background:rgba(255,255,255,.06)!important;border:1px solid rgba(255,255,255,.1)!important;border-radius:14px!important}',
      '#dsh-mini-top,#dsh-mini-bottom{position:fixed;left:0;right:0;z-index:2147482600;display:none;align-items:center;gap:8px;padding:0 10px;font:11px/1.2 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;color:#e8ecf5;-webkit-app-region:no-drag}',
      '#dsh-mini-top{top:0;height:34px;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(10,12,17,.72);backdrop-filter:blur(10px)}',
      '#dsh-mini-bottom{bottom:0;height:40px;border-top:1px solid rgba(255,255,255,.07);background:rgba(10,12,17,.72);backdrop-filter:blur(10px)}',
      'html[data-dsh-mini] #dsh-mini-top,html[data-dsh-mini] #dsh-mini-bottom{display:flex}',
      '#dsh-mini-top .task{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cfd6e3}',
      '#dsh-mini-top .dot{width:7px;height:7px;border-radius:50%;background:#5ad07f;flex:none}',
      '#dsh-mini-top .dot[data-running="1"]{background:#ffb020;animation:dsh-mini-pulse 1s infinite}',
      '@keyframes dsh-mini-pulse{50%{opacity:.4}}',
      '#dsh-mini-top button,#dsh-mini-bottom button{height:20px;padding:0 7px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:#e8ecf5;font-size:10px;cursor:pointer}',
      '#dsh-mini-bottom .stat{white-space:nowrap;color:#9fb0c9}',
      '#dsh-mini-bottom .stat b{color:#e8ecf5;font-weight:600}',
      '#dsh-mini-bottom .spacer{flex:1}',
      '#dsh-mini-bottom .perm{cursor:pointer;border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:2px 6px;color:#ffd479}'
    ].join('');
    document.head.appendChild(s);
  }

  function ensureBars() {
    if (document.getElementById('dsh-mini-top')) return;
    var shell = document.createElement('div');
    shell.id = 'dsh-mini-shell';
    document.body.appendChild(shell);
    var top = document.createElement('div');
    top.id = 'dsh-mini-top';
    top.innerHTML = '<span class="dot" id="dsh-mini-dot"></span><span class="task" id="dsh-mini-task">当前任务</span><button id="dsh-mini-exit" type="button">还原</button>';
    var bottom = document.createElement('div');
    bottom.id = 'dsh-mini-bottom';
    bottom.innerHTML = '<span class="stat">Token <b id="dsh-mini-tokens">—</b></span>'
      + '<span class="stat">缓存 <b id="dsh-mini-cache">—</b></span>'
      + '<span class="stat">上下文 <b id="dsh-mini-context">—</b></span>'
      + '<span class="spacer"></span>'
      + '<span class="stat">余额 <b id="dsh-mini-balance">—</b></span>'
      + '<span class="perm" id="dsh-mini-perm">工作区内修改</span>';
    document.body.appendChild(top);
    document.body.appendChild(bottom);
    document.getElementById('dsh-mini-exit').onclick = function () {
      fetch(exitUrl, { method: 'POST', credentials: 'same-origin' }).catch(function () {});
      setMini(false);
    };
    document.getElementById('dsh-mini-perm').onclick = togglePermission;
  }

  function setMini(on) {
    if (on) {
      style();
      ensureBars();
      document.documentElement.setAttribute('data-dsh-mini', '1');
      refresh();
    } else {
      document.documentElement.removeAttribute('data-dsh-mini');
    }
  }

  function textOf(selector) {
    var el = document.querySelector(selector);
    return el ? (el.textContent || '') : '';
  }

  function pick(re, scope) {
    var text = scope.textContent || '';
    var m = text.match(re);
    return m ? m[1] : null;
  }

  function refresh() {
    if (!document.documentElement.hasAttribute('data-dsh-mini')) return;
    var tokens = document.getElementById('dsh-mini-tokens');
    var cache = document.getElementById('dsh-mini-cache');
    var context = document.getElementById('dsh-mini-context');
    var balance = document.getElementById('dsh-mini-balance');
    var task = document.getElementById('dsh-mini-task');
    var dot = document.getElementById('dsh-mini-dot');
    var perm = document.getElementById('dsh-mini-perm');
    if (!tokens) return;

    var conversation = document.querySelector('[data-conversation-region]') || document.body;
    var header = document.querySelector('[data-conversation-header]');
    var title = header ? (header.textContent || '').trim().split('\n')[0] : '';
    task.textContent = title || '对话';
    dot.setAttribute('data-running', document.querySelector('[data-chat-running],[data-turn-process]') ? '1' : '0');

    var cacheMatch = conversation.textContent.match(/缓存命中\s*([0-9.]+%)/);
    cache.textContent = cacheMatch ? cacheMatch[1] : '—';
    var ctxMatch = document.body.textContent.match(/上下文已用\s*([0-9]+%)/);
    context.textContent = ctxMatch ? ctxMatch[1] : '—';
    var tokMatch = document.body.textContent.match(/([0-9][0-9.,]*\s*[kKmM]?\s*tokens)/);
    tokens.textContent = tokMatch ? tokMatch[1] : '—';
    var balMatch = document.body.textContent.match(/¥\s*([0-9][0-9.,]*)/);
    balance.textContent = balMatch ? ('¥' + balMatch[1]) : '—';

    var permEl = document.querySelector('[data-slot="conversation.input.permission"]');
    if (permEl) {
      var label = (permEl.textContent || '').replace(/\s+/g, ' ').trim();
      perm.textContent = /完全/.test(label) ? '完全权限' : '工作区内修改';
    }
  }

  function togglePermission() {
    var selector = document.querySelector('[data-slot="conversation.input.permission"]');
    if (!selector) return;
    var current = (selector.textContent || '');
    var target = /完全/.test(current) ? '工作区内修改' : '完全权限';
    selector.click();
    setTimeout(function () {
      var items = Array.prototype.slice.call(document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],button'));
      var hit = items.filter(function (el) { return (el.textContent || '').indexOf(target) >= 0; })[0];
      if (hit) hit.click();
      setTimeout(function () {
        var confirm = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (el) {
          return /启用完全权限|确认/.test(el.textContent || '');
        })[0];
        if (confirm) confirm.click();
        refresh();
      }, 400);
    }, 250);
  }

  setInterval(refresh, 3000);
  document.addEventListener('click', function () { setTimeout(refresh, 500); }, true);
  function syncBySize(){
    if (window.innerWidth <= 620) setMini(true);
    else if (window.innerWidth > 700) setMini(false);
  }
  window.addEventListener('resize', syncBySize);
  setInterval(syncBySize, 1500);

  fetch(stateUrl, { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (s) { if (s && s.mini) setMini(true); })
    .catch(function () {});

  window.__dshOptimizerSetMini = setMini;
  window.__dshOptimizerEnterMini = function () {
    fetch(enterUrl, { method: 'POST', credentials: 'same-origin' }).then(function () { setMini(true); }).catch(function () {});
  };
})();`

export function registerMini(ctx, deps) {
  const { HOME, POWERSHELL, run, logLine } = deps
  const CONTROL = join(HOME, 'window-control.ps1')
  const WATCH = join(HOME, 'mini-watch.ps1')
  const WATCH_VBS = join(HOME, 'mini-watch.vbs')
  const TASK = 'DSH-Extension-Mini'

  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(CONTROL, windowScript(HOME), 'utf8')
    writeFileSync(WATCH, watchScript(HOME), 'utf8')
    writeFileSync(WATCH_VBS, [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "${POWERSHELL} -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${WATCH}""", 0, False`,
      '',
    ].join('\r\n'), 'utf8')
  } catch (error) {
    logLine(`mini scripts failed: ${String(error)}`)
  }

  async function startWatch() {
    await run('schtasks.exe', ['/Delete', '/TN', TASK, '/F'])
    const created = await run('schtasks.exe', ['/Create', '/TN', TASK, '/TR', `wscript.exe "${WATCH_VBS}"`, '/SC', 'ONCE', '/SD', '2030/12/31', '/ST', '23:59', '/F'])
    if (created.code !== 0) { logLine(`mini watch task failed: ${created.err || created.out}`); return }
    await run('schtasks.exe', ['/Run', '/TN', TASK])
  }
  // mini watchdog disabled: native minimise must stay a plain minimise
  // (window mode/resize is handled by the optimizer bar and window-control only)

  function control(action) {
    return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', CONTROL, '-Action', action])
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-extension/mini/enter',
    handler: async (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) return
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const result = await control('enter')
      logLine(`mini enter code=${result.code}`)
      res.writeHead(result.code === 0 ? 202 : 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: result.code === 0 }))
    },
  }), 'dsh-extension: mini enter')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-extension/mini/exit',
    handler: async (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) return
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const result = await control('exit')
      logLine(`mini exit code=${result.code}`)
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    },
  }), 'dsh-extension: mini exit')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-extension/mini/state',
    handler: (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) return
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ mini: false }))
    },
  }), 'dsh-extension: mini state')
}


