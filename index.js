/**
 * dsh-vision-click — complete tasks with nothing but the mouse.
 *
 * This plugin is the "eyes + hand" half of a UI-TARS style loop:
 *
 *   look   -> screenshot + OCR text index (every line with normalized coords)
 *   click  -> click a *named* target, located on a freshly captured frame
 *   verify -> diff the frame before/after, plus which text appeared/disappeared
 *
 * The agent supplies the System-2 reasoning; the plugin supplies precise
 * grounding and an honest verdict about whether the click did anything.
 *
 * Why OCR instead of a vision model: the model reading the screenshot already
 * knows *what* to click; what it cannot do reliably is turn "the 保存 button"
 * into exact pixels. Windows.Media.Ocr gives real bounding boxes offline, in
 * ~150ms, in Chinese and English, with no API key and no network.
 *
 * Safety, in order of importance:
 *   1. F6+F7 is watched by a separate OS process (scripts/stop-watcher.ps1): it
 *      writes a durable stop flag, kills the input daemon and releases every
 *      button/modifier before this module notices.
 *   2. Every input path fails closed when that watchdog is not running.
 *   3. Target clicks are resolved against a frame captured in the same call, so
 *      they can never be based on a stale picture. Point clicks require a fresh
 *      frame too.
 *   4. Once stopped, nothing is accepted until gui_rearm (confirm: true).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-vision-click';
export const inject = ['tools'];

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(PKG_DIR, 'scripts');
const OCR_DLL = path.join(PKG_DIR, 'native', 'DshOcr.dll');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- configuration

const CONFIG_FIELDS = {
  /** The user's switch. false = no capture, no clicks, full stop. */
  allowControl: { type: 'boolean', default: true },
  /** Emergency stop combo, VK names joined by '+'. */
  emergencyHotkey: { type: 'string', default: 'F6+F7' },
  /** Cancel the running agent turn when the combo fires. */
  cancelTurnOnStop: { type: 'boolean', default: true },
  /** Width of the image returned to the model; 0 keeps native pixels. */
  maxWidth: { type: 'number', default: 1600 },
  /** A point click may only use a frame younger than this. */
  maxCaptureAgeMs: { type: 'number', default: 20000 },
  /** Grace period after a click before the verifying screenshot. */
  settleMs: { type: 'number', default: 260 },
  /** Put the cursor back where it was after clicking: no hover highlight or
   *  tooltip left behind, and the user's pointer does not get hijacked. */
  restoreCursor: { type: 'boolean', default: true },
  /** OCR upscale factor. 1 = native pixels; Windows OCR is best there on
   *  high-DPI screens. Larger values are only a fallback for very small text. */
  ocrScale: { type: 'number', default: 1 },
  /** OCR language tag, e.g. 'zh-Hans-CN'; empty = user profile languages. */
  ocrLang: { type: 'string', default: '' },
  /** Drag interpolation: more steps = smoother, slower, more reliable. */
  dragSteps: { type: 'number', default: 16 },
  /** Delay between drag steps (ms). */
  dragStepMs: { type: 'number', default: 12 },
  /** Upper bound for one gui_type call (characters). */
  maxTypeChars: { type: 'number', default: 2000 },
  /** Hard rate limit for real input actions. */
  maxActionsPerMinute: { type: 'number', default: 60 },
  /** Minimum match score required before a target click is allowed. */
  minMatchScore: { type: 'number', default: 0.7 },
  /** Diff grid resolution used by the verifier. */
  diffCellsX: { type: 'number', default: 24 },
  diffCellsY: { type: 'number', default: 16 },
  /** Append an audit line per action. */
  auditLog: { type: 'boolean', default: true },
  /** Optional explicit PowerShell path. */
  powershellPath: { type: 'string', default: '' },

  // ---- optional vision-model fallback (local Ollama, e.g. UI-TARS-7B) ----
  /** When OCR finds nothing (or is unsure), ask a local vision model where the target is. */
  visionEnabled: { type: 'boolean', default: false },
  /** Ollama-compatible base URL. */
  visionBaseUrl: { type: 'string', default: 'http://127.0.0.1:11434' },
  /** Model name as shown by `ollama list`, e.g. `ui-tars:7b`. */
  visionModel: { type: 'string', default: 'ui-tars:7b' },
  /** `fallback` = only when OCR is unsure; `always` = prefer the model. */
  visionMode: { type: 'string', default: 'fallback' },
  /** Per-call timeout for the vision model (ms). */
  visionTimeoutMs: { type: 'number', default: 30000 },
  /** Width the crop is downscaled to before it is sent. */
  visionMaxWidth: { type: 'number', default: 1280 },
  /** Snap radius (0..1 of the crop) when matching the model point to an OCR word box. */
  visionSnapRadius: { type: 'number', default: 0.08 },
  /** Extra clicks around the model point when the first one changes nothing (0 disables). */
  visionRetries: { type: 'number', default: 1 },
  /** If a drag changed nothing, re-locate both ends with the model and retry once. */
  visionOnDragRetry: { type: 'boolean', default: true },
  /** If a scroll changed nothing, re-locate the scrollable area with the model and retry once. */
  visionOnScrollRetry: { type: 'boolean', default: true },
};

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-vision-click',
    validate(input) {
      const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
      const issues = [];
      const value = {};

      for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
        const raw = source[key];
        if (raw === undefined || raw === null || raw === '') {
          value[key] = field.default;
          continue;
        }
        if (field.type === 'number') {
          const asNumber = typeof raw === 'number' ? raw : Number(raw);
          if (!Number.isFinite(asNumber)) {
            issues.push({ message: 'expected number', path: [key] });
            continue;
          }
          value[key] = asNumber;
          continue;
        }
        if (typeof raw !== field.type) {
          issues.push({ message: `expected ${field.type}`, path: [key] });
          continue;
        }
        value[key] = raw;
      }

      return issues.length > 0 ? { issues } : { value };
    },
  },
};

// ---------------------------------------------------------------- text helpers

/** Case/space/punctuation-insensitive form used for matching OCR output. */
function normalizeText(value) {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''《》〈〉（）【】「」『』…—·,\.!\?;:'"()\[\]{}<>|\\/`~@#$%^&*+=_-]/g, '')
    .toLowerCase();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  if (max > 96) {
    // Long paragraph: compare prefix windows instead of paying O(n*m).
    const size = Math.min(a.length, b.length, 48);
    return similarity(a.slice(0, size), b.slice(0, size));
  }
  return 1 - levenshtein(a, b) / max;
}

function fmt(n, digits = 3) {
  return Number(n).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function asText(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

// ---------------------------------------------------------------- plugin body

export function apply(ctx, config = {}) {
  const settings = {
    ...Object.fromEntries(Object.entries(CONFIG_FIELDS).map(([k, f]) => [k, f.default])),
    ...config,
  };
  if (!Number.isFinite(settings.maxWidth) || settings.maxWidth < 0) settings.maxWidth = 1600;
  if (!Number.isFinite(settings.maxCaptureAgeMs) || settings.maxCaptureAgeMs < 1000) settings.maxCaptureAgeMs = 20000;
  if (!Number.isFinite(settings.settleMs) || settings.settleMs < 0) settings.settleMs = 260;
  if (!Number.isFinite(settings.ocrScale) || settings.ocrScale < 1) settings.ocrScale = 1;
  if (settings.ocrScale > 3) settings.ocrScale = 3;
  if (!Number.isFinite(settings.maxActionsPerMinute) || settings.maxActionsPerMinute < 1) settings.maxActionsPerMinute = 60;
  if (!Number.isFinite(settings.dragSteps) || settings.dragSteps < 4) settings.dragSteps = 16;
  if (!Number.isFinite(settings.maxTypeChars) || settings.maxTypeChars < 1) settings.maxTypeChars = 2000;
  if (!Number.isFinite(settings.dragStepMs) || settings.dragStepMs < 0) settings.dragStepMs = 12;
  if (!Number.isFinite(settings.minMatchScore) || settings.minMatchScore < 0.3) settings.minMatchScore = 0.7;
  if (!Number.isFinite(settings.visionTimeoutMs) || settings.visionTimeoutMs < 1000) settings.visionTimeoutMs = 30000;
  if (!Number.isFinite(settings.visionMaxWidth) || settings.visionMaxWidth < 320) settings.visionMaxWidth = 1280;
  if (!Number.isFinite(settings.visionSnapRadius) || settings.visionSnapRadius <= 0) settings.visionSnapRadius = 0.08;
  if (!Number.isFinite(settings.visionRetries) || settings.visionRetries < 0) settings.visionRetries = 1;
  if (settings.visionRetries > 3) settings.visionRetries = 3;
  settings.visionMode = settings.visionMode === 'always' ? 'always' : 'fallback';
  if (!Number.isFinite(settings.diffCellsX)) settings.diffCellsX = 24;
  if (!Number.isFinite(settings.diffCellsY)) settings.diffCellsY = 16;

  const PS = settings.powershellPath || process.env.DSH_POWERSHELL || 'powershell.exe';
  const runtimeDir = path.join(os.tmpdir(), 'dsh-vision-click', String(process.pid));
  const shotDir = path.join(runtimeDir, 'shots');
  fs.mkdirSync(shotDir, { recursive: true });

  const stopFile = path.join(runtimeDir, 'emergency-stop.json');
  const pidFile = path.join(runtimeDir, 'daemon.pid');
  const auditFile = path.join(runtimeDir, 'audit.log');

  const state = {
    armed: true,
    haltedAt: 0,
    haltReason: '',
    lastCapture: null,
    lastAgentId: null,
    actionCount: 0,
    actionTimes: [],
    disposed: false,
    ocr: { available: null, languages: [], error: '' },
  };

  let daemon = null;
  let watcher = null;
  let watcherAlive = false;
  let watcherRestarts = 0;
  let seq = 0;
  let stopSeenAt = 0;

  // ------------------------------------------------------------------ auditing

  function audit(entry) {
    if (!settings.auditLog) return;
    try {
      fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    } catch {
      /* auditing must never break an action */
    }
  }

  // ------------------------------------------------------------------ daemon

  function failPending(d, error) {
    for (const [, waiter] of d.pending) {
      try {
        waiter.reject(error);
      } catch {
        /* already settled */
      }
    }
    d.pending.clear();
  }

  function handleDaemonLine(d, line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = d.pending.get(payload.id);
    if (!waiter) return;
    d.pending.delete(payload.id);
    if (payload.ok) waiter.resolve(payload.result ?? {});
    else waiter.reject(new Error(String(payload.error || '视觉点击进程返回失败')));
  }

  function startDaemon() {
    if (daemon?.alive) return daemon;

    const child = spawn(
      PS,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(SCRIPTS_DIR, 'agent.ps1'),
        '-PidFile',
        pidFile,
        '-StopFile',
        stopFile,
        '-OcrDll',
        OCR_DLL,
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const d = { child, alive: true, pending: new Map(), buffer: '', stderr: '' };
    daemon = d;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      d.buffer += chunk;
      let index;
      while ((index = d.buffer.indexOf('\n')) >= 0) {
        const line = d.buffer.slice(0, index).trim();
        d.buffer = d.buffer.slice(index + 1);
        if (line) handleDaemonLine(d, line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      d.stderr = (d.stderr + chunk).slice(-4000);
    });

    child.on('error', (error) => {
      d.alive = false;
      failPending(d, error);
      if (daemon === d) daemon = null;
    });

    child.on('exit', (code) => {
      d.alive = false;
      const detail = d.stderr.trim().split('\n').slice(-3).join(' | ');
      failPending(d, new Error(`视觉点击进程已退出（code=${code}）${detail ? `：${detail}` : ''}`));
      if (daemon === d) daemon = null;
    });

    return d;
  }

  function killDaemon(reason) {
    const d = daemon;
    daemon = null;
    if (!d) return;
    d.alive = false;
    try {
      d.child.kill();
    } catch {
      /* already gone */
    }
    failPending(d, new Error(`视觉点击进程已停止（${reason}）`));
    ctx.logger?.info?.(`[vision-click] agent stopped: ${reason}`);
  }

  async function daemonRequest(op, args = {}, { timeoutMs = 30000, signal } = {}) {
    const d = startDaemon();
    if (!d.alive) throw new Error('视觉点击进程没有启动成功');

    const id = ++seq;
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('调用已取消'));
        return;
      }

      const timer = setTimeout(() => {
        d.pending.delete(id);
        reject(new Error(`视觉点击进程 ${timeoutMs}ms 内没有响应（${op}）`));
      }, timeoutMs);

      const finish = (fn) => (value) => {
        clearTimeout(timer);
        try {
          signal?.removeEventListener?.('abort', onAbort);
        } catch {
          /* ignore */
        }
        fn(value);
      };
      const onAbort = finish(() => reject(new Error('调用已取消')));

      d.pending.set(id, { resolve: finish(resolve), reject: finish(reject), op });
      try {
        signal?.addEventListener?.('abort', onAbort, { once: true });
      } catch {
        /* ignore */
      }

      try {
        d.child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
      } catch (error) {
        d.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function withDaemon(retry, fn) {
    try {
      return await fn();
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!retry || !/没有启动成功|已退出|没有响应/.test(message)) throw error;
      killDaemon('restart after failure');
      await sleep(200);
      return await fn();
    }
  }

  // ------------------------------------------------------------------ watchdog

  function startWatcher() {
    if (state.disposed) return;
    try {
      const child = spawn(
        PS,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(SCRIPTS_DIR, 'stop-watcher.ps1'),
          '-StopFile',
          stopFile,
          '-DaemonPidFile',
          pidFile,
          '-Hotkey',
          settings.emergencyHotkey,
          '-PollMs',
          '40',
          '-ParentPid',
          String(process.pid),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );

      watcher = child;
      watcherAlive = true;

      let buffer = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          if (line.includes('emergency_stop')) handleEmergency({ hotkey: settings.emergencyHotkey, at: Date.now() });
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });

      child.on('exit', (code) => {
        watcherAlive = false;
        watcher = null;
        if (state.disposed) return;
        const detail = stderr.trim().split('\n').slice(-2).join(' | ');
        ctx.logger?.warn?.(`[vision-click] 急停看门狗退出（code=${code}）${detail ? `：${detail}` : ''}`);
        if (watcherRestarts < 8) {
          watcherRestarts += 1;
          setTimeout(() => {
            if (!state.disposed) startWatcher();
          }, 800);
        } else {
          ctx.logger?.error?.('[vision-click] 急停看门狗反复启动失败：已按失败关闭处理，不再输入');
        }
      });
    } catch (error) {
      watcherAlive = false;
      ctx.logger?.error?.(`[vision-click] 急停看门狗启动失败：${error?.message || error}`);
    }
  }

  function handleEmergency(info = {}) {
    if (state.disposed) return;
    if (state.haltedAt) return;

    const at = Number(info.at) || Date.now();
    state.armed = false;
    state.haltedAt = at;
    state.haltReason = String(info.hotkey || settings.emergencyHotkey);

    killDaemon('emergency stop');
    audit({ action: 'emergency_stop', hotkey: state.haltReason, at, agent: state.lastAgentId });

    ctx.logger?.warn?.(`[vision-click] 急停触发（${state.haltReason}）：输入已切断`);

    if (!settings.cancelTurnOnStop) return;
    const agentId = state.lastAgentId;
    if (!agentId) return;

    const controller = ctx.get('sessionController');
    if (!controller?.cancel) return;

    try {
      controller.cancel({ sessionId: agentId });
      audit({ action: 'cancel_turn', session: agentId });
    } catch (error) {
      ctx.logger?.error?.(`[vision-click] 取消回合失败：${error?.message || error}`);
    }
  }

  const stopTimer = setInterval(() => {
    if (state.disposed) return;
    let raw;
    try {
      raw = fs.readFileSync(stopFile, 'utf8');
    } catch {
      return;
    }
    let info;
    try {
      info = JSON.parse(raw);
    } catch {
      return;
    }
    const at = Number(info?.at);
    if (!at || at <= stopSeenAt) return;
    stopSeenAt = at;
    handleEmergency({ ...info, at });
  }, 250);
  if (typeof stopTimer.unref === 'function') stopTimer.unref();

  // ------------------------------------------------------------------ guards

  function assertControlAllowed() {
    if (!settings.allowControl) {
      throw new Error('视觉点击已被用户在插件配置里关闭（allowControl: false），本工具不会截屏也不会动鼠标。');
    }
  }

  function assertArmed() {
    if (state.armed) return;
    throw new Error(
      `任务已被用户按下 ${state.haltReason || settings.emergencyHotkey} 强制停止，鼠标输入已锁定。` +
        '不要重试。等用户明确要求继续后，再调用 gui_rearm（confirm: true）。',
    );
  }

  function assertWatchdog() {
    if (watcherAlive) return;
    throw new Error(
      '急停看门狗（F6+F7）没有运行，为保证随时能急停，已拒绝一切鼠标输入。' +
        '请让用户重新加载视觉点击插件，或查看插件日志。',
    );
  }

  function assertRate() {
    const now = Date.now();
    state.actionTimes = state.actionTimes.filter((t) => now - t < 60000);
    if (state.actionTimes.length >= settings.maxActionsPerMinute) {
      throw new Error(
        `一分钟内已执行 ${state.actionTimes.length} 次鼠标动作（上限 ${settings.maxActionsPerMinute}）。` +
          '先停下来核对当前画面，不要陷入盲点循环。',
      );
    }
    state.actionTimes.push(now);
  }

  function assertFreshFrame() {
    const cap = state.lastCapture;
    if (!cap) {
      throw new Error('还没有看过屏幕。先调用 gui_look 截图，再描述目标。');
    }
    const age = Date.now() - cap.at;
    if (age > settings.maxCaptureAgeMs) {
      throw new Error(
        `上一张截图已经是 ${(age / 1000).toFixed(1)} 秒前（上限 ${settings.maxCaptureAgeMs / 1000} 秒），` +
          '画面可能已经变了。先重新 gui_look，再点击。',
      );
    }
    return cap;
  }

  function requireAttachments() {
    const attachments = ctx.get('attachments');
    if (!attachments) throw new Error('当前组合没有挂载 attachments 服务，无法把截图作为图片返回。');
    return attachments;
  }

  function pruneShots() {
    try {
      const files = fs
        .readdirSync(shotDir)
        .filter((f) => f.endsWith('.png'))
        .map((f) => ({ f, t: fs.statSync(path.join(shotDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const stale of files.slice(32)) {
        try {
          fs.rmSync(path.join(shotDir, stale.f), { force: true });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ capture

  async function capture(exec, { area = 'primary', maxWidth, note } = {}) {
    const attachments = requireAttachments();
    const outPath = path.join(shotDir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    const result = await withDaemon(true, () =>
      daemonRequest(
        'screen',
        { area, maxWidth: Number.isFinite(maxWidth) ? maxWidth : settings.maxWidth, outPath },
        { timeoutMs: 30000, signal: exec?.signal },
      ),
    );

    const png = fs.readFileSync(result.shownPath ?? result.path);
    const ref = await attachments.saveImage({
      data: new Uint8Array(png),
      mediaType: 'image/png',
      name: path.basename(result.shownPath ?? result.path),
    });

    state.lastCapture = {
      at: Date.now(),
      originX: result.originX,
      originY: result.originY,
      width: result.width,
      height: result.height,
      shownWidth: result.shownWidth,
      shownHeight: result.shownHeight,
      area: result.area,
      path: result.path,
      shownPath: result.shownPath,
      ref,
    };

    audit({
      action: 'screenshot',
      area: result.area,
      width: result.width,
      height: result.height,
      agent: exec?.agent?.id,
      note: note ?? null,
    });

    pruneShots();
    return { result, ref, png, outPath: result.path, shownPath: result.shownPath };
  }

  async function ocrFrame(imagePath, exec, scale = settings.ocrScale, rect = null) {
    const raw = await withDaemon(true, () =>
      daemonRequest(
        'ocr',
        { path: imagePath, scale, lang: settings.ocrLang, rect: rect ?? null },
        { timeoutMs: 25000, signal: exec?.signal },
      ),
    );
    state.ocr.available = true;
    state.ocr.languages = state.ocr.languages?.length ? state.ocr.languages : [];
    raw.scale = raw.scale ?? scale;
    return raw;
  }

  /** Foreground window in physical pixels, or null when there is none. */
  async function foregroundWindow(exec) {
    try {
      const info = await withDaemon(false, () => daemonRequest('window', {}, { timeoutMs: 5000, signal: exec?.signal }));
      if (!info || !(Number(info.w) > 0) || !(Number(info.h) > 0)) return null;
      return info;
    } catch {
      return null;
    }
  }

  /** Convert a screen rect into screenshot pixels, clamped to the captured frame. */
  function clampToFrame(rect, result) {
    const x0 = Math.max(0, Math.round(rect.x - result.originX));
    const y0 = Math.max(0, Math.round(rect.y - result.originY));
    const x1 = Math.min(result.width, Math.round(rect.x - result.originX + rect.w));
    const y1 = Math.min(result.height, Math.round(rect.y - result.originY + rect.h));
    if (x1 - x0 < 24 || y1 - y0 < 24) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Split a rect into overlapping horizontal bands (Windows OCR reads them better). */
  function bandsOf(rect, count = 3) {
    const out = [];
    const bandH = Math.ceil(rect.h / count);
    const overlap = Math.max(24, Math.round(bandH * 0.3));
    for (let i = 0; i < count; i += 1) {
      const y = Math.max(rect.y, rect.y + i * bandH - (i === 0 ? 0 : overlap));
      const bottom = Math.min(rect.y + rect.h, rect.y + (i + 1) * bandH + overlap);
      const h = bottom - y;
      if (h >= 24) out.push({ x: rect.x, y, w: rect.w, h });
    }
    return out;
  }

  function dedupeLines(lines) {
    const seen = new Map();
    for (const line of lines) {
      const key = `${normalizeText(line.text)}@${line.cx.toFixed(2)},${line.cy.toFixed(2)}`;
      if (!seen.has(key)) seen.set(key, line);
    }
    return [...seen.values()].map((line, i) => ({ ...line, id: i + 1 }));
  }

  /** Turn raw OCR output into model-facing lines with normalized coordinates. */
  function indexLines(raw) {
    const W = Math.max(1, raw.width);
    const H = Math.max(1, raw.height);
    const list = Array.isArray(raw.lines) ? raw.lines : [];
    return list
      .filter((l) => l && l.w > 0 && l.h > 0)
      .map((l, i) => {
        const words = Array.isArray(l.words)
          ? l.words
              .filter((w) => Array.isArray(w) && String(w[0] ?? '').trim())
              .map((w) => ({
                text: String(w[0]),
                px: { x: Number(w[1]) || 0, y: Number(w[2]) || 0, w: Number(w[3]) || 0, h: Number(w[4]) || 0 },
              }))
          : [];
        return {
          id: i + 1,
          text: String(l.text ?? '').trim(),
          px: { x: l.x, y: l.y, w: l.w, h: l.h },
          norm: { x: l.x / W, y: l.y / H, w: l.w / W, h: l.h / H },
          cx: (l.x + l.w / 2) / W,
          cy: (l.y + l.h / 2) / H,
          words,
        };
      })
      .filter((l) => l.text.length > 0);
  }

  function unitFromBox(text, box, W, H) {
    return {
      text,
      x: box.x / W,
      y: box.y / H,
      w: box.w / W,
      h: box.h / H,
      cx: (box.x + box.w / 2) / W,
      cy: (box.y + box.h / 2) / H,
      area: Math.max(1, box.w) * Math.max(1, box.h),
    };
  }

  /**
   * Clickable units inside one OCR line: the whole line, plus every run of
   * 1..4 words. Windows OCR happily merges neighbouring controls into one line
   * ("网易有道翻译 MATLAB"), so a word run is often the precise target while the
   * line box would land between two icons.
   */
  function unitsOf(line, W, H) {
    const units = [unitFromBox(line.text, line.px, W, H)];
    const words = line.words;
    if (words.length > 1) {
      for (let size = 1; size <= Math.min(4, words.length); size += 1) {
        for (let start = 0; start + size <= words.length; start += 1) {
          const slice = words.slice(start, start + size);
          const x0 = Math.min(...slice.map((w) => w.px.x));
          const y0 = Math.min(...slice.map((w) => w.px.y));
          const x1 = Math.max(...slice.map((w) => w.px.x + w.px.w));
          const y1 = Math.max(...slice.map((w) => w.px.y + w.px.h));
          const text = slice.map((w) => w.text).join('');
          units.push(unitFromBox(text, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, W, H));
        }
      }
    }
    return units;
  }

  function inRegion(unit, region) {
    if (!region) return true;
    const r = region;
    return (
      unit.cx >= Number(r.x) &&
      unit.cx <= Number(r.x) + Number(r.w) &&
      unit.cy >= Number(r.y) &&
      unit.cy <= Number(r.y) + Number(r.h)
    );
  }

  function scoreUnit(unitText, targetNorm, exact) {
    if (unitText === targetNorm) return 1;
    if (exact) return 0;
    // A single character (or a target shorter than 2 chars) is too weak to act on:
    // "第" would match 第一步/第一页 and click the wrong control.
    if (targetNorm.length < 2) return 0;
    if (unitText.includes(targetNorm)) return 0.84 + 0.12 * (targetNorm.length / unitText.length);
    if (targetNorm.includes(unitText) && unitText.length >= 3) {
      // The target is longer than this unit: only accept when the unit covers
      // most of it ("保存" inside "点击保存按钮" is a lie; "保存按钮" is not).
      return unitText.length / targetNorm.length >= 0.8 ? 0.55 : 0;
    }
    // OCR sometimes drops the last glyph of a control ("下一步" -> "下一").
    // Such a fragment is reported as a low-confidence candidate so it can be
    // chosen explicitly with pick, but it stays below minMatchScore: never
    // clicked by guesswork.
    if (targetNorm.includes(unitText) && unitText.length >= 2 && unitText.length / targetNorm.length >= 0.6) {
      return 0.62;
    }
    const sim = similarity(unitText, targetNorm);
    return sim >= 0.72 ? 0.45 + 0.3 * sim : 0;
  }

  /**
   * Score every clickable unit against the requested target.
   * Exact > contains > fuzzy; a `near` point breaks ties between duplicates.
   */
  function findCandidates(lines, target, { near, region, exact } = {}) {
    const tn = normalizeText(target);
    if (!tn) return [];

    const W = Math.max(1, state.lastCapture?.width ?? 1);
    const H = Math.max(1, state.lastCapture?.height ?? 1);

    const scored = [];
    for (const line of lines) {
      if (!inRegion(line, region)) continue;
      let best = null;
      for (const unit of unitsOf(line, W, H)) {
        const ut = normalizeText(unit.text);
        if (!ut) continue;
        let score = scoreUnit(ut, tn, exact);
        if (score <= 0) continue;
        if (!inRegion(unit, region)) continue;

        if (near) {
          const dx = unit.cx - Number(near.x);
          const dy = unit.cy - Number(near.y);
          score -= Math.min(0.25, Math.sqrt(dx * dx + dy * dy) * 0.5);
        }

        // A hit hugging the frame border is almost always a mis-parsed line
        // (band offsets, window chrome, another app's tab strip). Clicking the
        // screen edge is never what the caller meant, so drop those.
        if (unit.cx < 0.004 || unit.cx > 0.996 || unit.cy < 0.004 || unit.cy > 0.996) continue;

        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && unit.area < best.unit.area)) {
          best = { line, unit, score };
        }
      }
      if (best) scored.push(best);
    }

    scored.sort((a, b) => b.score - a.score || a.unit.area - b.unit.area);

    // Collapse the same text found twice within a few pixels (OCR often emits
    // duplicate boxes for one control).
    const unique = [];
    for (const candidate of scored) {
      const duplicate = unique.find(
        (u) =>
          normalizeText(u.unit.text) === normalizeText(candidate.unit.text) &&
          Math.abs(u.unit.cx - candidate.unit.cx) < 0.008 &&
          Math.abs(u.unit.cy - candidate.unit.cy) < 0.008,
      );
      if (!duplicate) unique.push(candidate);
    }
    return unique;
  }

  function describeCandidates(candidates, limit = 6) {
    return candidates
      .slice(0, limit)
      .map(
        (c) =>
          `  #${c.line.id} 「${c.unit.text}」 得分 ${c.score.toFixed(2)} ` +
          `中心 (${fmt(c.unit.cx, 3)}, ${fmt(c.unit.cy, 3)}) 尺寸 ${Math.round(c.unit.w * 1000) / 10}%x${Math.round(c.unit.h * 1000) / 10}%`,
      )
      .join('\n');
  }

  // ------------------------------------------------------------------ diff

  async function diffFrames(beforePath, afterPath, exec, rect = null) {
    const raw = await withDaemon(true, () =>
      daemonRequest(
        'diff',
        {
          a: beforePath,
          b: afterPath,
          cellsX: Math.round(settings.diffCellsX),
          cellsY: Math.round(settings.diffCellsY),
          rect: rect ?? null,
        },
        { timeoutMs: 20000, signal: exec?.signal },
      ),
    );
    return raw;
  }

  function textDelta(beforeLines, afterLines) {
    // A ticking clock or a counter would otherwise look like "the click worked".
    const noise = (text) => /^[\d\s:：.\-–—/]+$/.test(text) || String(text).length <= 1;
    const keys = (lines) =>
      new Set(
        lines
          .filter((line) => !noise(line.text))
          .map((line) => normalizeText(line.text))
          .filter(Boolean),
      );

    const before = keys(beforeLines ?? []);
    const after = keys(afterLines ?? []);
    const appeared = [];
    const disappeared = [];
    for (const line of afterLines ?? []) {
      const key = normalizeText(line.text);
      if (key && !noise(line.text) && !before.has(key) && appeared.length < 8) appeared.push(line.text);
    }
    for (const line of beforeLines ?? []) {
      const key = normalizeText(line.text);
      if (key && !noise(line.text) && !after.has(key) && disappeared.length < 8) disappeared.push(line.text);
    }
    return { appeared, disappeared };
  }

  // ------------------------------------------------------------------ click core

  function pointToScreen(nx, ny, cap) {
    const px = Math.min(cap.width - 1, Math.max(0, nx * cap.width));
    const py = Math.min(cap.height - 1, Math.max(0, ny * cap.height));
    return { x: Math.round(cap.originX + px), y: Math.round(cap.originY + py), nx, ny };
  }

  async function doPointer(point, { button = 'left', count = 1, holdMs = 0, hover = false, exec }) {
    let saved = null;
    if (settings.restoreCursor && !hover) {
      try {
        saved = await daemonRequest('cursor', {}, { timeoutMs: 5000 });
      } catch {
        saved = null;
      }
    }

    const op = hover ? 'move' : holdMs > 0 ? 'press' : 'click';
    const payload = hover
      ? { x: point.x, y: point.y }
      : holdMs > 0
        ? { x: point.x, y: point.y, button, holdMs, count }
        : { x: point.x, y: point.y, button, count };

    await withDaemon(true, () => daemonRequest(op, payload, { timeoutMs: 30000, signal: exec?.signal }));
    state.actionCount += 1;
    if (settings.settleMs > 0) await sleep(settings.settleMs);

    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      try {
        await daemonRequest('move', { x: saved.x, y: saved.y }, { timeoutMs: 5000 });
      } catch {
        /* cosmetic only */
      }
    }

    audit({
      action: hover ? 'hover' : holdMs > 0 ? 'press' : 'click',
      screen: [point.x, point.y],
      normalized: [point.nx, point.ny],
      button,
      count,
      holdMs,
      agent: exec?.agent?.id,
    });
  }

  /** Mouse-down → stepped move → mouse-up, with the button always released. */
  async function doDrag(from, to, { button = 'left', durationMs = 0, exec }) {
    let saved = null;
    if (settings.restoreCursor) {
      try {
        saved = await daemonRequest('cursor', {}, { timeoutMs: 5000 });
      } catch {
        saved = null;
      }
    }

    const steps = Math.max(4, Math.round(settings.dragSteps));
    const stepMs = durationMs > 0 ? Math.min(100, Math.round(durationMs / steps)) : settings.dragStepMs;

    await withDaemon(true, () =>
      daemonRequest(
        'drag',
        { x1: from.x, y1: from.y, x2: to.x, y2: to.y, button, steps, stepMs },
        { timeoutMs: 40000, signal: exec?.signal },
      ),
    );
    state.actionCount += 1;
    if (settings.settleMs > 0) await sleep(settings.settleMs);

    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      try {
        await daemonRequest('move', { x: saved.x, y: saved.y }, { timeoutMs: 5000 });
      } catch {
        /* cosmetic only */
      }
    }

    audit({
      action: 'drag',
      from: [from.x, from.y],
      to: [to.x, to.y],
      button,
      steps,
      stepMs,
      agent: exec?.agent?.id,
    });
  }

  async function doScroll(point, { direction = 'down', amount = 3, horizontal = false, exec }) {
    await withDaemon(true, () =>
      daemonRequest(
        'scroll',
        { x: point.x, y: point.y, direction, amount, horizontal },
        { timeoutMs: 30000, signal: exec?.signal },
      ),
    );
    state.actionCount += 1;
    if (settings.settleMs > 0) await sleep(settings.settleMs);
    audit({ action: 'scroll', screen: [point.x, point.y], direction, amount, horizontal, agent: exec?.agent?.id });
  }

  // ---------------------------------------------------------------- vision fallback
  //
  // A local vision model (UI-TARS-7B via Ollama) is asked only when OCR cannot
  // decide. The model proposes a point; we then snap it to the nearest OCR word
  // box, so the final click is still anchored to a real, verifiable text box.
  // Precision comes from OCR, semantics from the model.

  function visionPrompt(target) {
    return (
      `Task: click the center of the ${target}\n` +
      `Output the action as: Action: click(start_box='<|box_start|>(x,y)<|box_end|>')`
    );
  }

  /** Ask the local vision model where `target` is. Returns frame-pixel coords. */
  async function visionLocate(cap, target, exec, rectOverride = null) {
    const win = !rectOverride && cap.result.area === 'primary' ? await foregroundWindow(exec) : null;
    const rect =
      rectOverride ??
      (win ? clampToFrame(win, cap.result) : { x: 0, y: 0, w: cap.result.width, h: cap.result.height });
    if (!rect) throw new Error('没有可用的裁剪区域');

    const outPath = path.join(shotDir, `vision-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
    const crop = await withDaemon(true, () =>
      daemonRequest(
        'crop',
        { path: cap.outPath, rect, maxWidth: settings.visionMaxWidth, outPath },
        { timeoutMs: 20000, signal: exec?.signal },
      ),
    );

    const b64 = fs.readFileSync(crop.path).toString('base64');
    const body = {
      model: settings.visionModel,
      prompt: visionPrompt(target),
      images: [b64],
      stream: false,
      options: { temperature: 0, num_predict: 64, num_ctx: 4096 },
    };

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.visionTimeoutMs);
    let data;
    try {
      const res = await fetch(`${String(settings.visionBaseUrl).replace(/\/+$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`vision HTTP ${res.status}`);
      data = await res.json();
    } catch (error) {
      const reason = error?.name === 'AbortError' ? `vision 超时（${settings.visionTimeoutMs}ms）` : String(error?.message || error);
      const wrapped = new Error(reason);
      wrapped.vision = { ok: false, ms: Date.now() - started, crop };
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }

    const ms = Date.now() - started;
    const text = String(data?.response ?? '').trim();
    const match = text.match(/\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/);
    if (!match) return { ok: false, ms, raw: text, crop };

    const nx = Number(match[1]) / 1000;
    const ny = Number(match[2]) / 1000;
    if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return { ok: false, ms, raw: text, crop };

    return {
      ok: true,
      ms,
      raw: text,
      crop,
      frame: {
        x: crop.rect.x + nx * crop.nativeWidth,
        y: crop.rect.y + ny * crop.nativeHeight,
        nx,
        ny,
      },
    };
  }

  /** Vision result (frame pixels) -> the plugin's screen-point shape. */
  function pointFromVision(v, cap) {
    return {
      x: Math.round(v.frame.x),
      y: Math.round(v.frame.y),
      nx: v.frame.x / cap.result.width,
      ny: v.frame.y / cap.result.height,
    };
  }

  /**
   * Snap a point to the nearest OCR word box that plausibly IS the target.
   * Snapping blindly would happily attach the point to an unrelated label that
   * happens to be nearby (e.g. a status line containing one shared character),
   * so a word only qualifies when its text relates to the target.
   */
  function snapToWords(framePoint, lines, radiusPx, target = '') {
    const tn = normalizeText(target);
    let nearest = null;
    let best = null;
    for (const line of lines) {
      for (const word of line.words ?? []) {
        const cx = word.px.x + word.px.w / 2;
        const cy = word.px.y + word.px.h / 2;
        const dist = Math.hypot(cx - framePoint.x, cy - framePoint.y);
        if (!nearest || dist < nearest.dist) nearest = { dist, cx, cy, word, line };
        if (dist > radiusPx) continue;

        const wt = normalizeText(word.text);
        const related = !!wt && !!tn && (tn.includes(wt) || wt.includes(tn) || similarity(wt, tn) >= 0.7);
        if (!related) continue;
        if (!best || dist < best.dist) best = { dist, cx, cy, word, line, related: true };
      }
    }
    return { best, nearest };
  }

  /**
   * Vision fallback: ask the local model, snap its point to an OCR word box,
   * and return the same shape as the OCR path (plus `source: 'vision'`).
   */
  async function visionFallback(cap, args, exec, ctx = {}) {
    let v;
    try {
      v = await visionLocate(cap, args.target, exec, ctx.winRect ?? null);
    } catch (error) {
      const sample = (ctx.lines ?? []).slice(0, 18).map((l) => `「${l.text}」`).join(' ');
      throw new Error(
        `OCR 没能确定「${args.target}」，视觉模型兜底也失败：${error?.message || error}。\n` +
          '请确认 Ollama 在运行（ollama list 能看到模型），或调整 visionModel / visionBaseUrl。' +
          (sample ? `\n这一帧 OCR 读到的文字：${sample}` : ''),
      );
    }

    if (!v.ok) {
      const sample = (ctx.lines ?? []).slice(0, 18).map((l) => `「${l.text}」`).join(' ');
      throw new Error(
        `OCR 和视觉模型都没有把握「${args.target}」。模型原始输出：「${v.raw || '（空）'}」（${v.ms}ms）。\n` +
          '可以换更贴近界面原文的 target，或用 gui_look 看完整索引后给 point。' +
          (sample ? `\n这一帧 OCR 读到的文字：${sample}` : ''),
      );
    }

    let snapped = null;
    let snapLines = [];
    let snapError = '';
    try {
      // OCR over the banded window is the most reliable index we have — the
      // same input gui_look uses. Fall back to the crop, then to whatever the
      // resolver had already collected.
      const snapRects = ctx.winRect ? bandsOf(ctx.winRect) : [v.crop.rect];
      const parts = [];
      for (const r of snapRects) {
        try {
          parts.push(...indexLines(await ocrFrame(cap.outPath, exec, 1, r)));
        } catch {
          /* one band failing is fine */
        }
      }
      snapLines = dedupeLines([...parts, ...(ctx.lines ?? [])]);
      const radius = settings.visionSnapRadius * Math.min(v.crop.nativeWidth, v.crop.nativeHeight);
      const { best, nearest } = snapToWords(v.frame, snapLines, radius, args?.target);
      snapped = best ?? null;
      if (nearest) {
        v.nearest = {
          dist: Math.round(nearest.dist),
          radius: Math.round(radius),
          text: nearest.word.text,
          related: !!best,
          x: Math.round(nearest.cx),
          y: Math.round(nearest.cy),
        };
      }
    } catch (error) {
      snapError = String(error?.message || error);
    }

    const frameX = snapped ? snapped.cx : v.frame.x;
    const frameY = snapped ? snapped.cy : v.frame.y;
    const point = pointToScreen(frameX / cap.result.width, frameY / cap.result.height, state.lastCapture);
    const chosen = snapped
      ? {
          id: snapped.line.id,
          text: snapped.word.text,
          cx: frameX / cap.result.width,
          cy: frameY / cap.result.height,
          area: snapped.word.px.w * snapped.word.px.h,
        }
      : null;

    audit({
      action: 'vision_locate',
      target: String(args?.target ?? ''),
      snapped: !!snapped,
      snappedText: snapped?.word?.text ?? null,
      ms: v.ms,
      point: [point.x, point.y],
      agent: exec?.agent?.id,
    });

    return {
      point,
      chosen,
      candidates: [],
      lines: snapLines.length ? snapLines : ctx.lines ?? [],
      scope: 'vision',
      rect: v.crop.rect,
      source: 'vision',
      vision: {
        ok: true,
        model: settings.visionModel,
        ms: v.ms,
        raw: v.raw,
        snapped: !!snapped,
        snappedText: snapped?.word?.text ?? null,
        snapDistancePx: snapped ? Math.round(snapped.dist) : null,
        snapLines: snapLines.length,
        snapError,
        nearest: v.nearest ?? null,
      },
    };
  }

  /** Capture a fresh frame and resolve a target text on it. */
  async function clickTarget(args, exec) {
    const area = args?.area === 'all' ? 'all' : 'primary';
    const cap = await capture(exec, { area, note: args?.note });
    const resolved = await resolveOnFrame(cap, args, exec);
    return { ...resolved, cap };
  }

  /**
   * Resolve a target text on an already captured frame.
   * Returns everything the model needs to judge the click.
   */
  async function resolveOnFrame(cap, args, exec) {
    const area = cap?.result?.area === 'all' ? 'all' : 'primary';

    // OCR quality depends on what it is given:
    //   * a window crop beats the whole desktop (small labels get merged or
    //     dropped on a 2560px frame);
    //   * horizontal bands beat the window crop, because Windows OCR sometimes
    //     ignores a control sitting in a tall paragraph-like block.
    // So: window, then the same window in three overlapping bands, then the
    // whole screen, then four screen tiles. Only failures pay for the extra passes.
    const win = area === 'primary' ? await foregroundWindow(exec) : null;
    const winRect = win ? clampToFrame(win, cap.result) : null;

    const W = cap.result.width;
    const H = cap.result.height;
    const tw = Math.ceil(W * 0.55);
    const th = Math.ceil(H * 0.55);

    const groups = [];
    if (winRect) groups.push({ scope: 'window', rects: [winRect], scale: 1 });
    if (winRect) groups.push({ scope: 'window-bands', rects: bandsOf(winRect), scale: 1 });
    groups.push({ scope: 'screen', rects: [null], scale: 1 });
    groups.push({
      scope: 'tiles',
      rects: [
        { x: 0, y: 0, w: tw, h: th },
        { x: W - tw, y: 0, w: tw, h: th },
        { x: 0, y: H - th, w: tw, h: th },
        { x: W - tw, y: H - th, w: tw, h: th },
      ],
      scale: 1.5,
    });

    let lines = [];
    let candidates = [];
    let scope = 'screen';
    let rect = null;
    let lastError = null;
    let usedOcr = false;
    const attempts = [];

    outer: for (const group of groups) {
      let merged = [];
      for (const r of group.rects) {
        try {
          const raw = await ocrFrame(cap.outPath, exec, group.scale, r);
          usedOcr = true;
          merged.push(...indexLines(raw));
        } catch (error) {
          lastError = error;
          break outer;
        }
        candidates = findCandidates(merged, args.target, {
          near: args?.near,
          region: args?.region,
          exact: args?.exact === true,
        });
        if (candidates.length > 0) break;
      }
      attempts.push({ scope: group.scope, lines: merged.length, hits: candidates.length });
      if (candidates.length > 0) {
        lines = merged;
        scope = group.scope === 'window-bands' ? 'window' : group.scope;
        rect = group.scope === 'screen' || group.scope === 'tiles' ? null : winRect ?? null;
        break;
      }
      lines = merged.length >= lines.length ? merged : lines;
      scope = group.scope === 'window-bands' ? 'window' : group.scope;
      rect = null;
    }

    // A band or a tile only sees part of the window, so "one match" there may
    // really be "one match among several". Before deciding, widen the evidence
    // with a full-window pass — otherwise a common label like 列表第 could be
    // clicked in the wrong row without the ambiguity check ever firing.
    if (candidates.length > 0 && (scope === 'window' || scope === 'tiles') && winRect) {
      try {
        const fullRaw = await ocrFrame(cap.outPath, exec, 1, winRect);
        const wider = findCandidates([...lines, ...indexLines(fullRaw)], args.target, {
          near: args?.near,
          region: args?.region,
          exact: args?.exact === true,
        });
        if (wider.length > candidates.length) {
          lines = [...lines, ...indexLines(fullRaw)];
          candidates = wider;
          scope = 'window';
          rect = winRect;
        }
      } catch {
        /* the extra evidence is best effort */
      }
    }

    if (!usedOcr) {
      throw new Error(
        `无法做文字识别，因而无法按名称定位「${args?.target}」：${lastError?.message || lastError}。` +
          '可以用 gui_look 看图后改用 point 坐标点击（例如 {"point":{"x":0.42,"y":0.31}}）。',
      );
    }

    // OCR is unsure (no candidate, or only a weak one): ask the local vision
    // model, then snap its point onto the nearest OCR word box.
    const needVision =
      settings.visionEnabled &&
      (settings.visionMode === 'always' || candidates.length === 0 || candidates[0].score < settings.minMatchScore);

    if (needVision) {
      const vision = await visionFallback(cap, args, exec, { winRect, lines, lastError });
      if (vision) return vision;
    }

    if (lines.length === 0) {
      throw new Error('这一帧没有识别到任何文字。如果目标不是文字（图标/图块），请用 gui_look 看图后给 point 坐标。');
    }

    if (candidates.length === 0) {
      const sample = lines
        .slice(0, 24)
        .map((l) => `「${l.text}」`)
        .join(' ');
      throw new Error(
        `画面上找不到「${args.target}」。${sample ? `识别到的文字有：${sample}（共 ${lines.length} 行）` : ''}\n` +
          `尝试过的范围：${attempts.map((a) => `${a.scope}→${a.lines}行`).join('，')}\n` +
          '换一个更接近界面上原文的 target，或用 gui_look 看完整索引后给 point。',
      );
    }

    if (candidates[0].score < settings.minMatchScore) {
      throw new Error(
        `「${args.target}」只有把握不大的近似匹配（最高 ${candidates[0].score.toFixed(2)} < ${settings.minMatchScore}），` +
          `为避免点错，这一下没有点。可以用原文重试，或明确用 pick 选一个：\n${describeCandidates(candidates)}`,
      );
    }

    let chosen;
    if (typeof args?.pick === 'number' && Number.isFinite(args.pick)) {
      const index = Math.round(args.pick) - 1;
      if (index < 0 || index >= candidates.length) {
        throw new Error(`pick=${args.pick} 超出候选范围（共 ${candidates.length} 个）：\n${describeCandidates(candidates)}`);
      }
      chosen = candidates[index];
    } else {
      const [first, second] = candidates;
      const ambiguous =
        second &&
        first.score - second.score < 0.04 &&
        Math.hypot(first.unit.cx - second.unit.cx, first.unit.cy - second.unit.cy) > 0.02;
      if (ambiguous) {
        throw new Error(
          `「${args.target}」有多个可能的匹配，为避免点错，这一下没有点。请用 pick 指定序号，或加 near 指明大概位置：\n${describeCandidates(candidates)}`,
        );
      }
      chosen = first;
    }

    const point = pointToScreen(chosen.unit.cx, chosen.unit.cy, state.lastCapture);
    return {
      point,
      chosen: { id: chosen.line.id, text: chosen.unit.text, cx: chosen.unit.cx, cy: chosen.unit.cy, area: chosen.unit.area },
      candidates: candidates.slice(0, 5),
      cap,
      lines,
      scope,
      rect,
      source: 'ocr',
      vision: null,
    };
  }

  /** The window around a click that the verifier actually looks at. */
  function localRect(point, cap, R = 240) {
    const x0 = Math.max(0, Math.round(point.x - cap.result.originX - R));
    const y0 = Math.max(0, Math.round(point.y - cap.result.originY - R));
    const x1 = Math.min(cap.result.width, Math.round(point.x - cap.result.originX + R));
    const y1 = Math.min(cap.result.height, Math.round(point.y - cap.result.originY + R));
    if (x1 - x0 < 32 || y1 - y0 < 32) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  async function verify(cap, { textCheck, beforeLines, exec, ocrRect = null, clickPoint = null, radius = 240 }) {
    const after = await capture(exec, { area: cap.result.area, note: 'verify' });
    const local = clickPoint ? localRect(clickPoint, cap, radius) : null;
    const diff = await diffFrames(cap.outPath, after.outPath, exec, local);
    // A click can change something far away (a status line at the top of the
    // window, a new panel). Local diff answers "did the target react"; global
    // diff answers "did anything at all happen".
    const globalDiff = local ? await diffFrames(cap.outPath, after.outPath, exec, null) : diff;

    let delta = { appeared: [], disappeared: [] };
    let afterLines = [];
    let textError = '';
    if (textCheck) {
      try {
        if (ocrRect) {
          const merged = [];
          for (const band of bandsOf(ocrRect)) {
            const bandRaw = await ocrFrame(after.outPath, exec, settings.ocrScale, band);
            merged.push(...indexLines(bandRaw));
          }
          afterLines = dedupeLines(merged);
        } else {
          const rawAfter = await ocrFrame(after.outPath, exec, settings.ocrScale, null);
          afterLines = indexLines(rawAfter);
        }
        delta = textDelta(beforeLines ?? [], afterLines);
      } catch (error) {
        textError = String(error?.message || error);
      }
    }

    const localChanged = diff.changed >= 1 && diff.maxDelta >= 0.03;
    const globalChanged = globalDiff.changed >= 1 && globalDiff.maxDelta >= 0.05;
    const changed = localChanged || globalChanged || delta.appeared.length > 0 || delta.disappeared.length > 0;
    return { after, diff, globalDiff, delta, afterLines, changed, local, localChanged, globalChanged, textError, beforeCount: (beforeLines ?? []).length };
  }

  function verdictText(verifyResult, frame = null) {
    const { diff, globalDiff, delta, changed, local } = verifyResult;
    const W = frame?.width ?? diff.width;
    const H = frame?.height ?? diff.height;
    const ox = frame?.originX ?? 0;
    const oy = frame?.originY ?? 0;
    const parts = [];
    if (changed) {
      if (verifyResult.localChanged) {
        parts.push(`点击处有反应（${diff.changed}/${diff.totalCells} 格变化）`);
      }
      if (verifyResult.globalChanged && !verifyResult.localChanged) {
        parts.push(`点击处没变，但画面别处变了（${globalDiff.changed} 格），可能是状态栏/提示更新`);
      }
      if (verifyResult.localChanged && verifyResult.globalChanged && globalDiff.changed > diff.changed) {
        parts.push(`画面其它地方还有 ${globalDiff.changed} 格变化`);
      }
    } else {
      parts.push(
        `点击处和整个画面都没有可测量的变化（最大 ${(Math.max(diff.maxDelta, globalDiff.maxDelta) * 100).toFixed(1)}% 单格差异），` +
          '这一下可能没点中，或界面本来就没反应',
      );
    }
    if (delta.appeared?.length) parts.push(`新出现：${delta.appeared.map((t) => `「${t}」`).join(' ')}`);
    if (delta.disappeared?.length) parts.push(`消失：${delta.disappeared.map((t) => `「${t}」`).join(' ')}`);
    if (verifyResult.textError) parts.push(`文字复核失败：${verifyResult.textError}`);
    else if (!delta.appeared?.length && !delta.disappeared?.length && verifyResult.beforeCount === 0) {
      parts.push('文字复核没有基线（点击前没做 OCR），只能靠像素判断');
    }
    if (diff.bbox && local) {
      parts.push(
        `点击处变化区域约在 (${fmt((diff.bbox.x + ox) / W, 3)}, ${fmt((diff.bbox.y + oy) / H, 3)}) ` +
          `到 (${fmt((diff.bbox.x + ox + diff.bbox.w) / W, 3)}, ${fmt((diff.bbox.y + oy + diff.bbox.h) / H, 3)})`,
      );
    }
    return parts.join('；');
  }

  function attachmentOf(shotRef, value) {
    return {
      type: 'image',
      attachment: {
        attachmentId: shotRef.attachmentId,
        mediaType: shotRef.mediaType ?? 'image/png',
        bytes: shotRef.bytes,
        width: shotRef.width,
        height: shotRef.height,
      },
    };
  }

  function renderWithImage(ref, message) {
    const blocks = asText(message);
    if (ref) blocks.push(attachmentOf(ref));
    return blocks;
  }

  // ------------------------------------------------------------------ tools

  const lookTool = {
    name: 'gui_look',
    description:
      '看一眼屏幕，同时给出**文字索引**：OCR 把画面上每一行文字都定位出来，附 0~1 归一化中心坐标。\n' +
      '这是纯鼠标任务的眼睛：先 gui_look，看清哪些字是按钮/链接，再 gui_click 用目标文字点它。\n' +
      '返回的图也给你看布局；point 坐标相对这张图（左上 0,0，右下 1,1）。\n' +
      'query 可以只看包含某个词的若干行（比如 "保存"），maxLines 控制索引行数。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '只看包含这个词的文字行（可选）' },
        maxLines: { type: 'integer', description: '最多返回多少行索引，默认 60' },
        scope: {
          type: 'string',
          description: 'window（默认：只识别当前活动窗口，最准）| screen（整个屏幕）| auto',
        },
        area: { type: 'string', description: 'primary（默认，主屏）| all（所有显示器）' },
        maxWidth: { type: 'integer', description: '返回图最大宽度，默认取插件配置；0 = 原始像素' },
        note: { type: 'string', description: '这次要看什么，会写进审计日志' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          shownWidth: { type: 'integer' },
          shownHeight: { type: 'integer' },
          area: { type: 'string' },
          ocr: { type: 'object', additionalProperties: true },
          lineCount: { type: 'integer' },
          lines: { type: 'array', items: { type: 'object', additionalProperties: true } },
          attachmentId: { type: 'string' },
          attachmentMediaType: { type: 'string' },
          attachmentBytes: { type: 'integer' },
          attachmentWidth: { type: 'integer' },
          attachmentHeight: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderWithImage(
          value.attachmentId
            ? {
                attachmentId: value.attachmentId,
                mediaType: value.attachmentMediaType,
                bytes: value.attachmentBytes,
                width: value.attachmentWidth,
                height: value.attachmentHeight,
              }
            : null,
          value.message ?? '',
        );
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertControlAllowed();
      assertArmed();
      assertWatchdog();
      state.lastAgentId = exec?.agent?.id ?? state.lastAgentId;

      const area = args?.area === 'all' ? 'all' : 'primary';
      const maxWidth = args?.maxWidth === 0 ? 0 : Math.min(4096, Math.max(320, Number(args?.maxWidth) || settings.maxWidth));
      const maxLines = Math.min(200, Math.max(1, Number(args?.maxLines) || 60));

      const cap = await capture(exec, { area, maxWidth, note: args?.note });

      // Reading one window beats reading the whole desktop: OCR merges or drops
      // small labels on a 2560x1600 frame, but reads the same window crop well.
      const scopeArg = args?.scope === 'screen' ? 'screen' : args?.scope === 'window' ? 'window' : 'auto';
      let win = null;
      let rect = null;
      if (scopeArg !== 'screen' && area === 'primary') {
        win = await foregroundWindow(exec);
        if (win) rect = clampToFrame(win, cap.result);
      }
      const scope = rect ? 'window' : 'screen';
      if (scope === 'screen') rect = null;

      let raw = null;
      let lines = [];
      let ocrError = '';
      try {
        if (rect) {
          const merged = [];
          for (const band of bandsOf(rect)) {
            const bandRaw = await ocrFrame(cap.outPath, exec, settings.ocrScale, band);
            raw = bandRaw;
            merged.push(...indexLines(bandRaw));
          }
          lines = dedupeLines(merged);
        } else {
          raw = await ocrFrame(cap.outPath, exec, settings.ocrScale, null);
          lines = indexLines(raw);
        }
      } catch (error) {
        ocrError = String(error?.message || error);
        state.ocr.available = false;
        state.ocr.error = ocrError;
      }

      const query = normalizeText(args?.query);
      const shown = query ? lines.filter((l) => normalizeText(l.text).includes(query)) : lines;

      const header = [
        args?.note ? `备注：${args.note}` : null,
        `屏幕已抓取（${cap.result.area}）：物理 ${cap.result.width}x${cap.result.height}` +
          `，返回图 ${cap.result.shownWidth}x${cap.result.shownHeight}` +
          `${cap.result.scaled ? `（已等比缩小 ${(cap.result.width / cap.result.shownWidth).toFixed(2)} 倍）` : ''}。`,
        raw
          ? `文字识别（${scope === 'window' ? `活动窗口「${win?.title ?? ''}」` : '整个屏幕'}）：${raw.lang}，共 ${lines.length} 行` +
            `${query ? `，其中 ${shown.length} 行包含「${args.query}」` : ''}。`
          : `文字识别不可用：${ocrError}`,
        '点击时说目标文字即可（gui_click target），不必自己算坐标；点完它会自动再截一张图告诉你有没有变化。',
      ].filter(Boolean);

      const body = shown
        .slice(0, maxLines)
        .map((l) => {
          const id = String(l.id).padStart(3, ' ');
          return `${id}. (${fmt(l.cx, 3)}, ${fmt(l.cy, 3)})  ${l.text}`;
        })
        .join('\n');

      if (shown.length > maxLines) header.push(`（只列了前 ${maxLines} 行，共 ${shown.length} 行；用 query 过滤或调大 maxLines。）`);

      return {
        ok: true,
        path: cap.result.path,
        width: cap.result.width,
        height: cap.result.height,
        shownWidth: cap.result.shownWidth,
        shownHeight: cap.result.shownHeight,
        area: cap.result.area,
        ocr: {
          available: !!raw,
          lang: raw?.lang ?? '',
          error: ocrError,
          scale: raw?.scale ?? 0,
          scope,
          window: win ? { title: win.title ?? '', process: win.processName ?? '', pid: win.pid ?? 0 } : null,
        },
        lineCount: shown.length,
        lines: shown.slice(0, 200).map((l) => ({
          id: l.id,
          text: l.text,
          cx: Number(l.cx.toFixed(4)),
          cy: Number(l.cy.toFixed(4)),
          px: l.px,
        })),
        attachmentId: cap.ref.attachmentId,
        attachmentMediaType: cap.ref.mediaType,
        attachmentBytes: cap.ref.bytes,
        attachmentWidth: cap.ref.width,
        attachmentHeight: cap.ref.height,
        message: `${header.join('\n')}\n\n${body}`.trim(),
      };
    },
    presentCall(args) {
      return { card: 'generic', title: args?.query ? `看屏幕（找「${args.query}」）` : '看屏幕', kind: 'read' };
    },
  };

  const clickTool = {
    name: 'gui_click',
    description:
      '鼠标左/右/中键操作，并且默认自动校验结果。三种动作：\n' +
      '1) 普通点击（默认）；count:2 是双击；button:"right" 是右键（会弹出上下文菜单，记得再 gui_look 看菜单）。\n' +
      '2) 长按：holdMs: 800 —— 按下、按住 800ms、松开，用于长按菜单、拖拽前的"按住不放"。\n' +
      '3) 悬停：hover: true —— 只把指针移过去不按键，用于触发 hover 菜单/tooltip。\n' +
      '定位方式二选一：target: "保存"（OCR 找这行文字，点它的中心，现抓现点）或 point: {x,y}（0~1 归一化坐标，相对最近一次 gui_look 的图）。\n' +
      '点完会自动再截一张图：局部像素差分 + 全屏差分 + 文字增删对比，告诉你到底有没有反应。' +
      '如果显示"没有可测量的变化"，不要连点同一处，先 gui_look 看新画面。\n' +
      '同一个词有多个匹配时会拒绝执行并列出候选，用 pick 指定序号或 near 指明位置。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '要点击的文字（界面上的原文），如 "保存"、"新建会话"、"确定"' },
        point: {
          type: 'object',
          description: '0~1 归一化坐标；与 target 二选一',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          additionalProperties: false,
        },
        near: {
          type: 'object',
          description: '大概位置（0~1），用于在多个同名候选中挑最近的一个',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          additionalProperties: false,
        },
        pick: { type: 'integer', description: '候选序号（从上次 gui_click 的候选列表里选）' },
        region: {
          type: 'object',
          description: '只在这个 0~1 区域内找文字',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
          additionalProperties: false,
        },
        exact: { type: 'boolean', description: '只接受完全相同的文字（默认允许包含与模糊匹配）' },
        button: { type: 'string', description: 'left（默认）| right | middle' },
        count: { type: 'integer', description: '点击次数，默认 1；2 表示双击' },
        holdMs: { type: 'integer', description: '长按毫秒数；>0 时按下-按住-松开，而不是快速点击' },
        hover: { type: 'boolean', description: 'true = 只移动指针悬停，不按键' },
        area: { type: 'string', description: 'primary（默认）| all；target 模式决定在哪个范围里找' },
        textCheck: { type: 'boolean', description: '是否在点击后再 OCR 一次做文字增删对比，默认 true' },
        note: { type: 'string', description: '为什么点这一下，会写进审计日志' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          clicked: { type: 'object', additionalProperties: true },
          target: { type: 'object', additionalProperties: true },
          source: { type: 'string' },
          retried: { type: 'integer' },
          vision: { type: 'object', additionalProperties: true },
          candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          verify: { type: 'object', additionalProperties: true },
          attachmentId: { type: 'string' },
          attachmentMediaType: { type: 'string' },
          attachmentBytes: { type: 'integer' },
          attachmentWidth: { type: 'integer' },
          attachmentHeight: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderWithImage(
          value.attachmentId
            ? {
                attachmentId: value.attachmentId,
                mediaType: value.attachmentMediaType,
                bytes: value.attachmentBytes,
                width: value.attachmentWidth,
                height: value.attachmentHeight,
              }
            : null,
          value.message ?? '',
        );
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertControlAllowed();
      assertArmed();
      assertWatchdog();
      state.lastAgentId = exec?.agent?.id ?? state.lastAgentId;

      const button = ['left', 'right', 'middle'].includes(args?.button) ? args.button : 'left';
      const count = Math.min(3, Math.max(1, Number(args?.count) || 1));
      const holdMs = Math.min(10000, Math.max(0, Number(args?.holdMs) || 0));
      const hover = args?.hover === true;
      const textCheck = args?.textCheck !== false;
      const hasPoint = args?.point && Number.isFinite(Number(args.point.x)) && Number.isFinite(Number(args.point.y));

      assertRate();

      let point;
      let chosen = null;
      let candidates = [];
      let beforeLines = [];
      let cap = null;

      let ocrRect = null;
      let scope = 'screen';
      let source = 'point';
      let vision = null;

      if (args?.target) {
        const resolved = await clickTarget(args, exec);
        point = resolved.point;
        chosen = resolved.chosen;
        candidates = resolved.candidates;
        beforeLines = resolved.lines;
        cap = resolved.cap;
        ocrRect = resolved.rect;
        scope = resolved.scope;
        source = resolved.source ?? 'ocr';
        vision = resolved.vision ?? null;
      } else if (hasPoint) {
        const frame = assertFreshFrame();
        cap = {
          result: {
            area: frame.area,
            originX: frame.originX,
            originY: frame.originY,
            width: frame.width,
            height: frame.height,
          },
          outPath: frame.path,
          ref: frame.ref,
        };
        const nx = Number(args.point.x);
        const ny = Number(args.point.y);
        if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) {
          throw new Error(`坐标 ${nx},${ny} 超出 0~1 范围。`);
        }
        point = pointToScreen(nx, ny, frame);
      } else {
        throw new Error('需要 target（按文字点）或 point（按 0~1 坐标点）之一。');
      }

      await doPointer(point, { button, count, holdMs, hover, exec });

      let verified = await verify(cap, { textCheck, beforeLines, exec, ocrRect, clickPoint: point });

      // A vision point can land on the edge of a target (icons have no text to
      // snap to). If the first click changed nothing, nudge around the model
      // point before giving up — the verification still decides the winner.
      let retried = 0;
      if (!verified.changed && source === 'vision' && settings.visionRetries > 0) {
        const offsets = [
          [14, 10],
          [-12, 12],
          [0, -16],
        ];
        for (let i = 0; i < Math.min(settings.visionRetries, offsets.length); i += 1) {
          const [dx, dy] = offsets[i];
          const nudged = {
            x: point.x + dx,
            y: point.y + dy,
            nx: (point.x + dx - cap.result.originX) / cap.result.width,
            ny: (point.y + dy - cap.result.originY) / cap.result.height,
          };
          await doPointer(nudged, { button, count, holdMs, hover, exec });
          verified = await verify(cap, { textCheck, beforeLines, exec, ocrRect, clickPoint: nudged });
          retried = i + 1;
          if (verified.changed) {
            point = nudged;
            break;
          }
        }
      }

      const verdict = verdictText(verified, cap.result);
      audit({
        action: 'gui_click',
        target: args?.target ?? null,
        point: [point.x, point.y],
        changed: verified.changed,
        ratio: verified.diff.ratio,
        agent: exec?.agent?.id,
        note: args?.note ?? null,
      });

      const verb = hover ? '悬停在' : holdMs > 0 ? `长按 ${holdMs}ms 于` : '已点击';
      const how = source === 'vision'
        ? `（OCR 没有把握，由视觉模型 ${vision?.model ?? ''} 定位 ${vision?.ms ?? '?'}ms` +
          `${vision?.snapped ? `，并吸附到「${vision.snappedText}」` : '，未吸附到文字框'}）`
        : scope === 'window'
          ? '（在活动窗口内识别）'
          : '';
      const lines = [
        chosen
          ? `${verb}「${chosen.text}」：它在画面 (${fmt(chosen.cx, 3)}, ${fmt(chosen.cy, 3)})，` +
            `实际${hover ? '移到' : '操作'}屏幕 (${point.x}, ${point.y})${button !== 'left' && !hover ? `（${button} 键）` : ''}` +
            `${count > 1 && !hover ? `，连点 ${count} 次` : ''}${how}。`
          : `${verb}画面 (${fmt(point.nx, 3)}, ${fmt(point.ny, 3)})，屏幕 (${point.x}, ${point.y})${how}。`,
        `核对：${verdict}`,
        verified.changed ? null : '下一步：先别重复同一位置。用 gui_look 看看新画面，再决定下一步。',
      ].filter(Boolean);

      return {
        ok: true,
        clicked: {
          x: point.x,
          y: point.y,
          nx: Number(point.nx.toFixed(4)),
          ny: Number(point.ny.toFixed(4)),
          button,
          count,
          holdMs,
          hover,
        },
        target: chosen
          ? { id: chosen.id, text: chosen.text, cx: Number(chosen.cx.toFixed(4)), cy: Number(chosen.cy.toFixed(4)) }
          : {},
        source,
        retried,
        vision: vision
          ? { model: vision.model, ms: vision.ms, snapped: vision.snapped, snappedText: vision.snappedText, snapLines: vision.snapLines, snapError: vision.snapError, nearest: vision.nearest, raw: vision.raw }
          : {},
        candidates: candidates.map((c) => ({
          id: c.line.id,
          text: c.unit.text,
          score: Number(c.score.toFixed(3)),
          cx: Number(c.unit.cx.toFixed(4)),
          cy: Number(c.unit.cy.toFixed(4)),
        })),
        verify: {
          changed: verified.changed,
          ratio: verified.diff.ratio,
          changedCells: verified.diff.changed,
          totalCells: verified.diff.totalCells,
          appeared: verified.delta.appeared,
          disappeared: verified.delta.disappeared,
          bbox: verified.diff.bbox
            ? {
                x: Number((verified.diff.bbox.x / verified.diff.width).toFixed(4)),
                y: Number((verified.diff.bbox.y / verified.diff.height).toFixed(4)),
                w: Number((verified.diff.bbox.w / verified.diff.width).toFixed(4)),
                h: Number((verified.diff.bbox.h / verified.diff.height).toFixed(4)),
              }
            : {},
          verdict,
        },
        attachmentId: verified.after.ref.attachmentId,
        attachmentMediaType: verified.after.ref.mediaType,
        attachmentBytes: verified.after.ref.bytes,
        attachmentWidth: verified.after.ref.width,
        attachmentHeight: verified.after.ref.height,
        message: lines.join('\n'),
      };
    },
    presentCall(args) {
      const label = args?.target ? `点击「${args.target}」` : '点击坐标';
      return { card: 'generic', title: label, kind: 'other' };
    },
  };

  /** Resolve one drag endpoint ({target} or {x,y}) on an existing frame. */
  async function endpointPoint(spec, cap, exec, label) {
    if (!spec) throw new Error(`${label} 需要 {target:"文字"} 或 {x,y}（0~1 坐标）`);
    if (spec.target) {
      const resolved = await resolveOnFrame(cap, spec, exec);
      return { point: resolved.point, chosen: resolved.chosen, lines: resolved.lines, rect: resolved.rect, source: resolved.source ?? 'ocr' };
    }
    const nx = Number(spec.x);
    const ny = Number(spec.y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      throw new Error(`${label} 的坐标必须是 0~1 范围内的 x / y。`);
    }
    return { point: pointToScreen(nx, ny, state.lastCapture), chosen: null, lines: [], rect: null, source: 'point' };
  }

  const dragTool = {
    name: 'gui_drag',
    description:
      '按住鼠标从一个点拖到另一个点：拖文件到文件夹、拖滑块、拖选文本、拖窗口、画图都靠它。\n' +
      'from / to 各写 {target:"文字"}（推荐，按 OCR 定位）或 {x,y}（0~1，相对最近一次 gui_look 的图）。\n' +
      '实现是"按下 → 分步移动 → 停一下 → 松开"，任何异常都会先松开鼠标键，不会留下按住的左键。\n' +
      '拖完自动复核落点附近与整屏变化，告诉你这次拖拽有没有真的生效。',
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'object',
          description: '起点：{target:"文字"} 或 {x,y}',
          properties: {
            target: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            pick: { type: 'integer' },
            near: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        to: {
          type: 'object',
          description: '终点：{target:"文字"} 或 {x,y}',
          properties: {
            target: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            pick: { type: 'integer' },
            near: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        button: { type: 'string', description: 'left（默认）| right | middle' },
        durationMs: { type: 'integer', description: '整个拖拽过程的时长（毫秒），默认按步数算；慢一点更容易被目标接受' },
        textCheck: { type: 'boolean', description: '拖完是否再做一次文字增删对比，默认 true' },
        note: { type: 'string', description: '为什么拖，会写进审计日志' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          retried: { type: 'integer' },
          drag: { type: 'object', additionalProperties: true },
          from: { type: 'object', additionalProperties: true },
          to: { type: 'object', additionalProperties: true },
          verify: { type: 'object', additionalProperties: true },
          attachmentId: { type: 'string' },
          attachmentMediaType: { type: 'string' },
          attachmentBytes: { type: 'integer' },
          attachmentWidth: { type: 'integer' },
          attachmentHeight: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderWithImage(
          value.attachmentId
            ? {
                attachmentId: value.attachmentId,
                mediaType: value.attachmentMediaType,
                bytes: value.attachmentBytes,
                width: value.attachmentWidth,
                height: value.attachmentHeight,
              }
            : null,
          value.message ?? '',
        );
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertControlAllowed();
      assertArmed();
      assertWatchdog();
      state.lastAgentId = exec?.agent?.id ?? state.lastAgentId;

      const button = ['left', 'right', 'middle'].includes(args?.button) ? args.button : 'left';
      const durationMs = Math.min(20000, Math.max(0, Number(args?.durationMs) || 0));
      const textCheck = args?.textCheck !== false;
      assertRate();

      const cap = await capture(exec, { note: args?.note });
      const from = await endpointPoint(args?.from, cap, exec, 'from');
      const to = await endpointPoint(args?.to, cap, exec, 'to');

      const dx = to.point.x - from.point.x;
      const dy = to.point.y - from.point.y;
      if (Math.hypot(dx, dy) < 6) {
        throw new Error('起点和终点几乎重合（<6px），这不像一次拖拽；如果只是想点击，请用 gui_click。');
      }

      await doDrag(from.point, to.point, { button, durationMs, exec });

      let verified = await verify(cap, {
        textCheck,
        beforeLines: [...from.lines, ...to.lines],
        exec,
        ocrRect: to.rect ?? from.rect,
        clickPoint: to.point,
        radius: 320,
      });

      // A drag that changed nothing usually means "the grab missed the handle"
      // (sliders, canvas objects, text-less drag handles). Ask the model where
      // both ends are NOW and try once more, from the new frame.
      let dragRetried = 0;
      if (!verified.changed && settings.visionEnabled && settings.visionOnDragRetry) {
        const base = verified.after;
        let fromV = null;
        let toV = null;
        try {
          fromV = await visionLocate(base, args?.from?.target ?? 'the element to drag', exec);
        } catch {
          fromV = null;
        }
        try {
          toV = await visionLocate(base, args?.to?.target ?? 'where to drop it', exec);
        } catch {
          toV = null;
        }
        const from2 = fromV?.ok ? pointFromVision(fromV, base) : from.point;
        const to2 = toV?.ok ? pointFromVision(toV, base) : to.point;
        if (Math.hypot(to2.x - from2.x, to2.y - from2.y) >= 6) {
          await doDrag(from2, to2, { button, durationMs, exec });
          const retryVerified = await verify(base, {
            textCheck,
            beforeLines: [],
            exec,
            ocrRect: toV?.crop?.rect ?? to.rect ?? from.rect,
            clickPoint: to2,
            radius: 320,
          });
          dragRetried = 1;
          if (retryVerified.changed) {
            verified = retryVerified;
            from.point = from2;
            to.point = to2;
          }
        }
      }

      const verdict = verdictText(verified, cap.result);

      audit({
        action: 'gui_drag',
        from: [from.point.x, from.point.y],
        to: [to.point.x, to.point.y],
        changed: verified.changed,
        agent: exec?.agent?.id,
        note: args?.note ?? null,
      });

      const label = (res, spec) => {
        if (res.chosen) return `「${res.chosen.text}」`;
        return `画面 (${fmt(res.point.nx, 3)}, ${fmt(res.point.ny, 3)})`;
      };

      const lines = [
        `已拖动：从 ${label(from)} 屏幕 (${from.point.x}, ${from.point.y}) ` +
          `拖到 ${label(to)} 屏幕 (${to.point.x}, ${to.point.y})` +
          `${button !== 'left' ? `（${button} 键）` : ''}，位移 ${Math.round(Math.hypot(dx, dy))}px。`,
        dragRetried
          ? '第一次拖拽没有生效，已用视觉模型重新定位两端并重试一次。'
          : null,
        `核对：${verdict}`,
      ].filter(Boolean);

      return {
        ok: true,
        retried: dragRetried,
        source: from.source === 'vision' || to.source === 'vision' ? 'vision' : 'ocr',
        drag: {
          from: { x: from.point.x, y: from.point.y },
          to: { x: to.point.x, y: to.point.y },
          button,
          distance: Math.round(Math.hypot(dx, dy)),
          durationMs,
        },
        from: from.chosen ? { text: from.chosen.text, x: from.point.x, y: from.point.y } : {},
        to: to.chosen ? { text: to.chosen.text, x: to.point.x, y: to.point.y } : {},
        verify: {
          changed: verified.changed,
          appeared: verified.delta.appeared,
          disappeared: verified.delta.disappeared,
          verdict,
        },
        attachmentId: verified.after.ref.attachmentId,
        attachmentMediaType: verified.after.ref.mediaType,
        attachmentBytes: verified.after.ref.bytes,
        attachmentWidth: verified.after.ref.width,
        attachmentHeight: verified.after.ref.height,
        message: lines.join('\n'),
      };
    },
    presentCall(args) {
      const from = args?.from?.target ? `从「${args.from.target}」` : '从坐标';
      const to = args?.to?.target ? `到「${args.to.target}」` : '到坐标';
      return { card: 'generic', title: `拖动：${from}${to}`, kind: 'other' };
    },
  };

  const scrollTool = {
    name: 'gui_scroll',
    description:
      '在某个位置滚动鼠标滚轮：翻列表、看长文档、缩放地图（按住 ctrl 的场景用 gui_click 的 mods 做不到，这里只滚轮）。\n' +
      '定位用 target（OCR 找文字，滚动它所在区域）或 point（0~1）。direction: down（默认）/ up / left / right。\n' +
      'amount 是滚轮格数（1 格 = 120），默认 3。滚完自动复核该区域是否真的滚动了；如果没变化，通常说明已经到头。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '滚动哪块区域：这段文字所在的窗口/列表' },
        point: {
          type: 'object',
          description: '0~1 坐标（相对最近一次 gui_look 的图）',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          additionalProperties: false,
        },
        direction: { type: 'string', description: 'down（默认）| up | left | right' },
        amount: { type: 'integer', description: '滚轮格数，默认 3，上限 20' },
        textCheck: { type: 'boolean', description: '是否做文字增删对比，默认 true' },
        note: { type: 'string', description: '为什么滚，会写进审计日志' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          scroll: { type: 'object', additionalProperties: true },
          verify: { type: 'object', additionalProperties: true },
          attachmentId: { type: 'string' },
          attachmentMediaType: { type: 'string' },
          attachmentBytes: { type: 'integer' },
          attachmentWidth: { type: 'integer' },
          attachmentHeight: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderWithImage(
          value.attachmentId
            ? {
                attachmentId: value.attachmentId,
                mediaType: value.attachmentMediaType,
                bytes: value.attachmentBytes,
                width: value.attachmentWidth,
                height: value.attachmentHeight,
              }
            : null,
          value.message ?? '',
        );
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertControlAllowed();
      assertArmed();
      assertWatchdog();
      state.lastAgentId = exec?.agent?.id ?? state.lastAgentId;

      const rawDirection = String(args?.direction ?? 'down').toLowerCase();
      const direction = ['up', 'down', 'left', 'right'].includes(rawDirection) ? rawDirection : 'down';
      const horizontal = direction === 'left' || direction === 'right';
      const amount = Math.min(20, Math.max(1, Number(args?.amount) || 3));
      const textCheck = args?.textCheck !== false;
      assertRate();

      let cap;
      let point;
      let chosen = null;
      let beforeLines = [];
      let ocrRect = null;

      if (args?.target) {
        const resolved = await clickTarget(args, exec);
        cap = resolved.cap;
        point = resolved.point;
        chosen = resolved.chosen;
        beforeLines = resolved.lines;
        ocrRect = resolved.rect;
      } else if (args?.point && Number.isFinite(Number(args.point.x)) && Number.isFinite(Number(args.point.y))) {
        const frame = assertFreshFrame();
        cap = {
          result: {
            area: frame.area,
            originX: frame.originX,
            originY: frame.originY,
            width: frame.width,
            height: frame.height,
          },
          outPath: frame.path,
          ref: frame.ref,
        };
        point = pointToScreen(Number(args.point.x), Number(args.point.y), frame);
      } else {
        throw new Error('需要 target（滚动这段文字所在区域）或 point（0~1 坐标）之一。');
      }

      await doScroll(point, { direction, amount, horizontal, exec });

      let verified = await verify(cap, {
        textCheck,
        beforeLines,
        exec,
        ocrRect,
        clickPoint: point,
        radius: 420,
      });

      // Nothing moved: either the pointer sat on a dead spot, or the list is
      // already at its end. Ask the model where the scrollable area is now and
      // try once at that point; if it still does not move, report "at the end".
      let scrollRetried = 0;
      if (!verified.changed && settings.visionEnabled && settings.visionOnScrollRetry) {
        const after = verified.after;
        const anchor = args?.target ?? 'the scrollable list';
        let v = null;
        try {
          v = await visionLocate(after, anchor, exec);
        } catch {
          v = null;
        }
        if (v?.ok) {
          const p2 = pointFromVision(v, after);
          await doScroll(p2, { direction, amount, horizontal, exec });
          const retryVerified = await verify(after, {
            textCheck,
            beforeLines: [],
            exec,
            ocrRect: v.crop.rect,
            clickPoint: p2,
            radius: 420,
          });
          scrollRetried = 1;
          if (retryVerified.changed) {
            verified = retryVerified;
            point = p2;
          }
        }
      }

      const verdict = verdictText(verified, cap.result);

      audit({ action: 'gui_scroll', point: [point.x, point.y], direction, amount, changed: verified.changed, agent: exec?.agent?.id });

      const lines = [
        `已在${chosen ? `「${chosen.text}」所在区域` : `画面 (${fmt(point.nx, 3)}, ${fmt(point.ny, 3)})`} ` +
          `向 ${direction} 滚了 ${amount} 格（屏幕 ${point.x}, ${point.y}）。`,
        scrollRetried ? '第一次滚动没有生效，已用视觉模型重新定位滚动区域并重试一次。' : null,
        `核对：${verdict}`,
        verified.changed ? null : '没有变化：可能已经滚到头，或者这块区域本身不可滚动——先 gui_look 确认，别反复滚。',
      ].filter(Boolean);

      return {
        ok: true,
        retried: scrollRetried,
        scroll: { direction, amount, horizontal, x: point.x, y: point.y },
        verify: {
          changed: verified.changed,
          appeared: verified.delta.appeared,
          disappeared: verified.delta.disappeared,
          verdict,
        },
        attachmentId: verified.after.ref.attachmentId,
        attachmentMediaType: verified.after.ref.mediaType,
        attachmentBytes: verified.after.ref.bytes,
        attachmentWidth: verified.after.ref.width,
        attachmentHeight: verified.after.ref.height,
        message: lines.join('\n'),
      };
    },
    presentCall(args) {
      return { card: 'generic', title: `滚轮：${args?.target ?? '坐标'}`, kind: 'other' };
    },
  };

  /** OCR baseline of the active window (bands merged), used before typing. */
  async function windowBaseline(cap, exec) {
    const win = cap.result.area === 'primary' ? await foregroundWindow(exec) : null;
    const rect = win ? clampToFrame(win, cap.result) : null;
    if (!rect) {
      const raw = await ocrFrame(cap.outPath, exec, settings.ocrScale, null);
      return { lines: indexLines(raw), rect: null };
    }
    const merged = [];
    for (const band of bandsOf(rect)) {
      const raw = await ocrFrame(cap.outPath, exec, settings.ocrScale, band);
      merged.push(...indexLines(raw));
    }
    return { lines: dedupeLines(merged), rect };
  }

  const typeTool = {
    name: 'gui_type',
    description:
      '往当前焦点控件里键入文字（先 gui_click 点中输入框/编辑器）。\n' +
      '支持英文大小写（按字面写入，"AbC" 就是 AbC）、数字、中文与符号；不受 CapsLock / 输入法状态影响。\n' +
      'pressEnter: true 会在最后按一次回车（搜索框、登录框的"提交"）。\n' +
      '输入后自动复核：画面变化 + 前后 OCR 文字增删，能看出"字到底进去了没有"。\n' +
      '如果显示没有变化，通常是没有焦点（先点一下输入区），或者焦点在不可编辑的控件上。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要键入的文字（字母/数字/中文/符号都行）' },
        pressEnter: { type: 'boolean', description: '输完是否按一次回车，默认 false' },
        delayMs: { type: 'integer', description: '每个字符间隔毫秒，默认 8；输入法/远程桌面可调大到 20-40' },
        textCheck: { type: 'boolean', description: '是否做输入前后的文字对比，默认 true' },
        note: { type: 'string', description: '输入什么内容/目的，会写进审计日志' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          typed: { type: 'object', additionalProperties: true },
          verify: { type: 'object', additionalProperties: true },
          attachmentId: { type: 'string' },
          attachmentMediaType: { type: 'string' },
          attachmentBytes: { type: 'integer' },
          attachmentWidth: { type: 'integer' },
          attachmentHeight: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderWithImage(
          value.attachmentId
            ? {
                attachmentId: value.attachmentId,
                mediaType: value.attachmentMediaType,
                bytes: value.attachmentBytes,
                width: value.attachmentWidth,
                height: value.attachmentHeight,
              }
            : null,
          value.message ?? '',
        );
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertControlAllowed();
      assertArmed();
      assertWatchdog();
      state.lastAgentId = exec?.agent?.id ?? state.lastAgentId;

      const text = String(args?.text ?? '');
      if (!text) throw new Error('text 不能为空');
      if (text.length > settings.maxTypeChars) {
        throw new Error(`这段文字有 ${text.length} 个字符，超过上限 ${settings.maxTypeChars}；请分段输入。`);
      }
      const pressEnter = args?.pressEnter === true;
      const delayMs = Math.min(200, Math.max(0, Number(args?.delayMs) || 8));
      const textCheck = args?.textCheck !== false;
      assertRate();

      const cap = await capture(exec, { note: args?.note });
      const base = await windowBaseline(cap, exec);

      await withDaemon(true, () =>
        daemonRequest('type', { text, delayMs, pressEnter }, { timeoutMs: 60000, signal: exec?.signal }),
      );
      state.actionCount += 1;
      if (settings.settleMs > 0) await sleep(settings.settleMs);

      const verified = await verify(cap, {
        textCheck,
        beforeLines: base.lines,
        exec,
        ocrRect: base.rect,
        clickPoint: null,
      });
      const verdict = verdictText(verified, cap.result);

      const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
      audit({
        action: 'gui_type',
        chars: text.length,
        preview,
        pressEnter,
        changed: verified.changed,
        agent: exec?.agent?.id,
        note: args?.note ?? null,
      });

      const lines = [
        `已键入 ${text.length} 个字符${pressEnter ? '，并在最后按了回车' : ''}：「${preview}」`,
        `核对：${verdict}`,
        verified.changed
          ? null
          : '没有变化：多半是没有输入焦点。先 gui_click 点中输入框（点空白处也算），再 gui_type。',
      ].filter(Boolean);

      return {
        ok: true,
        typed: { chars: text.length, preview, pressEnter },
        verify: {
          changed: verified.changed,
          appeared: verified.delta.appeared,
          disappeared: verified.delta.disappeared,
          verdict,
        },
        attachmentId: verified.after.ref.attachmentId,
        attachmentMediaType: verified.after.ref.mediaType,
        attachmentBytes: verified.after.ref.bytes,
        attachmentWidth: verified.after.ref.width,
        attachmentHeight: verified.after.ref.height,
        message: lines.join('\n'),
      };
    },
    presentCall(args) {
      const t = String(args?.text ?? '');
      return { card: 'generic', title: `键入 ${t.length > 20 ? `${t.slice(0, 20)}…` : t}`, kind: 'other' };
    },
  };

  const keyTool = {
    name: 'gui_key',
    description:
      '按一次组合键或功能键：enter、tab、esc、backspace、delete、方向键、home/end、pageup/pagedown、f1-f12，' +
      '以及 shift+a（大写）、ctrl+a（全选）、ctrl+c / ctrl+v、ctrl+z、ctrl+shift+s、alt+tab、win 等。\n' +
      '键名用加号连接、全小写；单个字符自动映射（"a"、"7"）。count 可以连按多次（比如 delete 删 3 个字符）。\n' +
      '这是发到当前焦点窗口的按键，不会移动鼠标。按完自动复核画面与文字变化。',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: '组合键，如 "enter"、"shift+a"、"ctrl+a"、"alt+tab"' },
        count: { type: 'integer', description: '连按次数，默认 1（上限 10）' },
        textCheck: { type: 'boolean', description: '是否做文字对比，默认 true' },
        note: { type: 'string', description: '为什么按这个键，会写进审计日志' },
      },
      required: ['keys'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'object', additionalProperties: true },
          verify: { type: 'object', additionalProperties: true },
          attachmentId: { type: 'string' },
          attachmentMediaType: { type: 'string' },
          attachmentBytes: { type: 'integer' },
          attachmentWidth: { type: 'integer' },
          attachmentHeight: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderWithImage(
          value.attachmentId
            ? {
                attachmentId: value.attachmentId,
                mediaType: value.attachmentMediaType,
                bytes: value.attachmentBytes,
                width: value.attachmentWidth,
                height: value.attachmentHeight,
              }
            : null,
          value.message ?? '',
        );
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertControlAllowed();
      assertArmed();
      assertWatchdog();
      state.lastAgentId = exec?.agent?.id ?? state.lastAgentId;

      const keys = String(args?.keys ?? '').trim();
      if (!keys) throw new Error('keys 不能为空');
      const count = Math.min(10, Math.max(1, Number(args?.count) || 1));
      const textCheck = args?.textCheck !== false;
      assertRate();

      const cap = await capture(exec, { note: args?.note });
      const base = await windowBaseline(cap, exec);

      let result;
      try {
        result = await withDaemon(true, () =>
          daemonRequest('key', { keys, count }, { timeoutMs: 30000, signal: exec?.signal }),
        );
      } catch (error) {
        const message = String(error?.message || error);
        if (/unknown key/.test(message)) {
          throw new Error(
            `${message}。可用键名：enter / tab / esc / space / backspace / delete / insert / up / down / left / right / ` +
              'home / end / pageup / pagedown / capslock / f1-f12，配合 ctrl / shift / alt / win，单个字母或数字也行。',
          );
        }
        throw error;
      }
      state.actionCount += 1;
      if (settings.settleMs > 0) await sleep(settings.settleMs);

      const verified = await verify(cap, {
        textCheck,
        beforeLines: base.lines,
        exec,
        ocrRect: base.rect,
        clickPoint: null,
      });
      const verdict = verdictText(verified, cap.result);

      audit({ action: 'gui_key', keys, count, changed: verified.changed, agent: exec?.agent?.id, note: args?.note ?? null });

      const lines = [
        `已按 ${keys}${count > 1 ? ` ×${count}` : ''}。`,
        `核对：${verdict}`,
        verified.changed ? null : '没有变化：可能焦点不在目标窗口，或这个按键在该控件上本来就没有效果。',
      ].filter(Boolean);

      return {
        ok: true,
        key: { keys, parts: result?.parts ?? [keys], count },
        verify: {
          changed: verified.changed,
          appeared: verified.delta.appeared,
          disappeared: verified.delta.disappeared,
          verdict,
        },
        attachmentId: verified.after.ref.attachmentId,
        attachmentMediaType: verified.after.ref.mediaType,
        attachmentBytes: verified.after.ref.bytes,
        attachmentWidth: verified.after.ref.width,
        attachmentHeight: verified.after.ref.height,
        message: lines.join('\n'),
      };
    },
    presentCall(args) {
      return { card: 'generic', title: `按键 ${args?.keys ?? ''}`, kind: 'other' };
    },
  };

  const waitTool = {
    name: 'gui_wait',
    description:
      '等某个文字出现或消失（加载完成、弹窗关掉、保存成功），期间每隔几百毫秒看一眼屏幕。' +
      '比"睡一会儿再看看"可靠：它一满足条件就返回，超时也会返回当时看到的文字，方便判断卡在哪里。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '要等待的文字' },
        state: { type: 'string', description: 'appear（默认，等它出现）| disappear（等它消失）' },
        timeoutMs: { type: 'integer', description: '超时毫秒，默认 15000，上限 120000' },
        query: { type: 'string', description: '超时时顺便报告包含这些字的行（可选）' },
        area: { type: 'string', description: 'primary（默认）| all' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          matched: { type: 'boolean' },
          elapsedMs: { type: 'integer' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          attachmentId: { type: 'string' },
          attachmentMediaType: { type: 'string' },
          attachmentBytes: { type: 'integer' },
          attachmentWidth: { type: 'integer' },
          attachmentHeight: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderWithImage(
          value.attachmentId
            ? {
                attachmentId: value.attachmentId,
                mediaType: value.attachmentMediaType,
                bytes: value.attachmentBytes,
                width: value.attachmentWidth,
                height: value.attachmentHeight,
              }
            : null,
          value.message ?? '',
        );
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertControlAllowed();
      assertArmed();
      assertWatchdog();
      state.lastAgentId = exec?.agent?.id ?? state.lastAgentId;

      const target = String(args?.target ?? '').trim();
      if (!target) throw new Error('target 不能为空');
      const want = args?.state === 'disappear' ? 'disappear' : 'appear';
      const timeout = Math.min(120000, Math.max(500, Number(args?.timeoutMs) || 15000));
      const area = args?.area === 'all' ? 'all' : 'primary';
      const started = Date.now();

      let lastLines = [];
      let cap = null;
      let matched = false;

      while (Date.now() - started <= timeout) {
        cap = await capture(exec, { area, note: `wait ${want} ${target}` });
        let lines = [];
        try {
          const win = area === 'primary' ? await foregroundWindow(exec) : null;
          const rect = win ? clampToFrame(win, cap.result) : null;
          const raw = await ocrFrame(cap.outPath, exec, settings.ocrScale, rect);
          lines = indexLines(raw);
        } catch (error) {
          throw new Error(`等待期间无法做文字识别：${error?.message || error}`);
        }
        lastLines = lines;

        const hits = findCandidates(lines, target, {});
        const present = hits.some((c) => c.score >= 0.8);
        if ((want === 'appear' && present) || (want === 'disappear' && !present)) {
          matched = true;
          break;
        }
        await sleep(320);
      }

      const elapsed = Date.now() - started;
      const hits = findCandidates(lastLines, target, {}).filter((c) => c.score >= 0.8);
      const sample = lastLines.slice(0, 18).map((l) => `「${l.text}」`).join(' ');

      const message = matched
        ? `已等到「${target}」${want === 'appear' ? '出现' : '消失'}，用时 ${(elapsed / 1000).toFixed(1)} 秒。`
        : `等了 ${(elapsed / 1000).toFixed(1)} 秒，「${target}」仍然${want === 'appear' ? '没有出现' : '没有消失'}。` +
          `${sample ? `\n当前识别到的文字：${sample}` : ''}\n先 gui_look 看画面，别继续盲等。`;

      audit({ action: want === 'appear' ? 'wait_appear' : 'wait_disappear', target, matched, elapsed, agent: exec?.agent?.id });

      return {
        ok: true,
        matched,
        elapsedMs: elapsed,
        hits: hits.slice(0, 5).map((c) => ({
          id: c.line.id,
          text: c.unit.text,
          cx: Number(c.unit.cx.toFixed(4)),
          cy: Number(c.unit.cy.toFixed(4)),
        })),
        attachmentId: cap?.ref?.attachmentId ?? '',
        attachmentMediaType: cap?.ref?.mediaType ?? 'image/png',
        attachmentBytes: cap?.ref?.bytes ?? 0,
        attachmentWidth: cap?.ref?.width ?? 0,
        attachmentHeight: cap?.ref?.height ?? 0,
        message,
      };
    },
  };

  const doTool = {
    name: 'gui_do',
    description:
      '把一串"只靠点击"的步骤一次跑完，每步都现抓现点，出错就停并报告卡在哪一步。\n' +
      'steps 里每项是：{"click":"文字"}、{"point":{"x":0.5,"y":0.5}}、{"wait":"文字","timeoutMs":8000}、{"sleep":500}。\n' +
      '适合"点开菜单 → 点保存 → 等已保存"这种确定的短流程（最多 10 步）。' +
      '流程不确定、需要看图判断时，还是逐步用 gui_look / gui_click。',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '步骤数组，按顺序执行',
          items: {
            type: 'object',
            properties: {
              click: { type: 'string', description: '要点击的文字' },
              point: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                additionalProperties: false,
              },
              wait: { type: 'string', description: '等这段文字出现' },
              hover: { type: 'string', description: '把指针悬停到这段文字上（不点击）' },
              type: { type: 'string', description: '向当前焦点控件键入这段文字' },
              key: { type: 'string', description: '按一次组合键，如 "enter"、"ctrl+a"' },
              pressEnter: { type: 'boolean', description: '配合 type：输完按回车' },
              count: { type: 'integer', description: '配合 key：连按次数' },
              drag: {
                type: 'object',
                description: '拖拽：{ from: {target|x,y}, to: {target|x,y} }',
                properties: {
                  from: { type: 'object', additionalProperties: true },
                  to: { type: 'object', additionalProperties: true },
                },
                required: ['from', 'to'],
                additionalProperties: false,
              },
              scroll: {
                type: 'object',
                description: '滚轮：{ target|x,y, direction:"down", amount:3 }',
                properties: {
                  target: { type: 'string' },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  direction: { type: 'string' },
                  amount: { type: 'integer' },
                },
                additionalProperties: false,
              },
              timeoutMs: { type: 'integer', description: '该步等待超时，默认 10000' },
              sleep: { type: 'integer', description: '纯等待毫秒' },
              pick: { type: 'integer', description: 'click 的候选序号' },
              near: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                additionalProperties: false,
              },
              note: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        stopOnNoChange: { type: 'boolean', description: '某一步点完画面没变化就停下，默认 false' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          completed: { type: 'integer' },
          total: { type: 'integer' },
          trace: { type: 'array', items: { type: 'object', additionalProperties: true } },
          attachmentId: { type: 'string' },
          attachmentMediaType: { type: 'string' },
          attachmentBytes: { type: 'integer' },
          attachmentWidth: { type: 'integer' },
          attachmentHeight: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderWithImage(
          value.attachmentId
            ? {
                attachmentId: value.attachmentId,
                mediaType: value.attachmentMediaType,
                bytes: value.attachmentBytes,
                width: value.attachmentWidth,
                height: value.attachmentHeight,
              }
            : null,
          value.message ?? '',
        );
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertControlAllowed();
      assertArmed();
      assertWatchdog();
      state.lastAgentId = exec?.agent?.id ?? state.lastAgentId;

      const steps = Array.isArray(args?.steps) ? args.steps.slice(0, 10) : [];
      if (steps.length === 0) throw new Error('steps 不能为空（最多 10 步）');

      const trace = [];
      let completed = 0;
      let ok = true;
      let failure = '';
      let lastShot = null;

      for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i] ?? {};
        const started = Date.now();
        try {
          if (step.sleep) {
            const ms = Math.min(30000, Math.max(0, Number(step.sleep) || 0));
            await sleep(ms);
            trace.push({ step: i + 1, kind: 'sleep', ms, ok: true });
          } else if (step.wait) {
            const timeout = Math.min(60000, Math.max(500, Number(step.timeoutMs) || 10000));
            const until = Date.now() + timeout;
            let seen = false;
            let cap = null;
            while (Date.now() <= until) {
              cap = await capture(exec, { note: `do wait ${step.wait}` });
              const raw = await ocrFrame(cap.outPath, exec);
              const lines = indexLines(raw);
              seen = findCandidates(lines, step.wait, {}).some((c) => c.score >= 0.8);
              if (seen) break;
              await sleep(320);
            }
            lastShot = cap;
            if (!seen) throw new Error(`等不到「${step.wait}」出现`);
            trace.push({ step: i + 1, kind: 'wait', target: step.wait, ok: true, elapsedMs: Date.now() - started });
          } else if (step.click) {
            assertRate();
            const resolved = await clickTarget({ target: step.click, pick: step.pick, near: step.near }, exec);
            await doPointer(resolved.point, { exec });
            const verified = await verify(resolved.cap, {
              textCheck: true,
              beforeLines: resolved.lines,
              exec,
              ocrRect: resolved.rect,
              clickPoint: resolved.point,
            });
            lastShot = verified.after;
            const verdict = verdictText(verified, resolved.cap.result);
            trace.push({
              step: i + 1,
              kind: 'click',
              target: step.click,
              matched: resolved.chosen?.text ?? null,
              x: resolved.point.x,
              y: resolved.point.y,
              changed: verified.changed,
              ratio: verified.diff.ratio,
              verdict,
              ok: true,
            });
            if (args?.stopOnNoChange === true && !verified.changed) {
              throw new Error(`点完「${step.click}」画面没有变化，按 stopOnNoChange 停下`);
            }
          } else if (step.point) {
            assertRate();
            const frame = assertFreshFrame();
            const nx = Number(step.point.x);
            const ny = Number(step.point.y);
            if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) throw new Error('point 必须在 0~1');
            const point = pointToScreen(nx, ny, frame);
            await doPointer(point, { exec });
            const verified = await verify(
              {
                result: { area: frame.area, originX: frame.originX, originY: frame.originY, width: frame.width, height: frame.height },
                outPath: frame.path,
                ref: frame.ref,
              },
              { textCheck: false, beforeLines: [], exec, clickPoint: point },
            );
            lastShot = verified.after;
            trace.push({
              step: i + 1,
              kind: 'point',
              x: point.x,
              y: point.y,
              changed: verified.changed,
              ratio: verified.diff.ratio,
              ok: true,
            });
          } else if (step.hover) {
            assertRate();
            const resolved = await clickTarget({ target: step.hover, pick: step.pick, near: step.near }, exec);
            await doPointer(resolved.point, { hover: true, exec });
            const verified = await verify(resolved.cap, {
              textCheck: true,
              beforeLines: resolved.lines,
              exec,
              ocrRect: resolved.rect,
              clickPoint: resolved.point,
            });
            lastShot = verified.after;
            trace.push({
              step: i + 1,
              kind: 'hover',
              target: step.hover,
              matched: resolved.chosen?.text ?? null,
              changed: verified.changed,
              ok: true,
            });
          } else if (step.drag) {
            assertRate();
            const cap = await capture(exec, { note: `do drag step ${i + 1}` });
            const from = await endpointPoint(step.drag.from, cap, exec, 'from');
            const to = await endpointPoint(step.drag.to, cap, exec, 'to');
            await doDrag(from.point, to.point, { exec });
            const verified = await verify(cap, {
              textCheck: true,
              beforeLines: [...from.lines, ...to.lines],
              exec,
              ocrRect: to.rect ?? from.rect,
              clickPoint: to.point,
              radius: 320,
            });
            lastShot = verified.after;
            trace.push({
              step: i + 1,
              kind: 'drag',
              from: [from.point.x, from.point.y],
              to: [to.point.x, to.point.y],
              changed: verified.changed,
              ok: true,
            });
            if (args?.stopOnNoChange === true && !verified.changed) {
              throw new Error(`拖拽第 ${i + 1} 步画面没有变化，按 stopOnNoChange 停下`);
            }
          } else if (step.scroll) {
            assertRate();
            const direction = String(step.scroll.direction ?? 'down');
            const amount = Math.min(20, Math.max(1, Number(step.scroll.amount) || 3));
            const horizontal = direction === 'left' || direction === 'right';
            let cap;
            let point;
            let beforeLines = [];
            let ocrRect = null;
            if (step.scroll.target) {
              const resolved = await clickTarget({ target: step.scroll.target }, exec);
              cap = resolved.cap;
              point = resolved.point;
              beforeLines = resolved.lines;
              ocrRect = resolved.rect;
            } else if (Number.isFinite(Number(step.scroll.x)) && Number.isFinite(Number(step.scroll.y))) {
              const frame = assertFreshFrame();
              cap = {
                result: { area: frame.area, originX: frame.originX, originY: frame.originY, width: frame.width, height: frame.height },
                outPath: frame.path,
                ref: frame.ref,
              };
              point = pointToScreen(Number(step.scroll.x), Number(step.scroll.y), frame);
            } else {
              throw new Error('scroll 步骤需要 target 或 x/y');
            }
            await doScroll(point, { direction, amount, horizontal, exec });
            const verified = await verify(cap, {
              textCheck: true,
              beforeLines,
              exec,
              ocrRect,
              clickPoint: point,
              radius: 420,
            });
            lastShot = verified.after;
            trace.push({
              step: i + 1,
              kind: 'scroll',
              direction,
              amount,
              changed: verified.changed,
              ok: true,
            });
          } else if (step.type || step.key) {
            assertRate();
            const cap = await capture(exec, { note: `do ${step.type ? 'type' : 'key'} step ${i + 1}` });
            const base = await windowBaseline(cap, exec);
            if (step.type) {
              await withDaemon(true, () =>
                daemonRequest(
                  'type',
                  { text: String(step.type), delayMs: 8, pressEnter: step.pressEnter === true },
                  { timeoutMs: 60000, signal: exec?.signal },
                ),
              );
            } else {
              await withDaemon(true, () =>
                daemonRequest('key', { keys: String(step.key), count: Math.min(10, Math.max(1, Number(step.count) || 1)) }, { timeoutMs: 30000, signal: exec?.signal }),
              );
            }
            state.actionCount += 1;
            if (settings.settleMs > 0) await sleep(settings.settleMs);
            const verified = await verify(cap, { textCheck: true, beforeLines: base.lines, exec, ocrRect: base.rect });
            lastShot = verified.after;
            trace.push({
              step: i + 1,
              kind: step.type ? 'type' : 'key',
              text: step.type ? String(step.type).slice(0, 20) : String(step.key),
              chars: step.type ? String(step.type).length : 0,
              changed: verified.changed,
              ok: true,
            });
          } else {
            throw new Error('未知步骤：需要 click / hover / drag / scroll / type / key / point / wait / sleep 之一');
          }
          completed += 1;
        } catch (error) {
          ok = false;
          failure = `第 ${i + 1} 步失败：${error?.message || error}`;
          trace.push({ step: i + 1, kind: 'error', ok: false, error: String(error?.message || error) });
          break;
        }
      }

      if (!lastShot) {
        try {
          lastShot = await capture(exec, { note: 'do final' });
        } catch {
          lastShot = null;
        }
      }

      audit({ action: 'gui_do', steps: steps.length, completed, ok, agent: exec?.agent?.id });

      const summary = trace
        .map((t) => {
          if (t.kind === 'click') return `${t.step}. 点「${t.target}」→ ${t.changed ? '有变化' : '无变化'}（${(t.ratio * 100).toFixed(1)}%）`;
          if (t.kind === 'wait') return `${t.step}. 等到「${t.target}」`;
          if (t.kind === 'sleep') return `${t.step}. 等 ${t.ms}ms`;
          if (t.kind === 'point') return `${t.step}. 点 (${t.x}, ${t.y})`;
          if (t.kind === 'hover') return `${t.step}. 悬停「${t.target}」`;
          if (t.kind === 'drag') return `${t.step}. 拖动 (${t.from.join(',')}) → (${t.to.join(',')})`;
          if (t.kind === 'scroll') return `${t.step}. 滚轮 ${t.direction} ${t.amount} 格`;
          return `${t.step}. 失败：${t.error}`;
        })
        .join('\n');

      const message = ok
        ? `已完成 ${completed}/${steps.length} 步：\n${summary}`
        : `${failure}\n已完成 ${completed}/${steps.length} 步：\n${summary}\n先 gui_look 看当前画面，再决定下一步。`;

      return {
        ok,
        completed,
        total: steps.length,
        trace,
        attachmentId: lastShot?.ref?.attachmentId ?? '',
        attachmentMediaType: lastShot?.ref?.mediaType ?? 'image/png',
        attachmentBytes: lastShot?.ref?.bytes ?? 0,
        attachmentWidth: lastShot?.ref?.width ?? 0,
        attachmentHeight: lastShot?.ref?.height ?? 0,
        message,
      };
    },
    presentCall(args) {
      return { card: 'generic', title: `点击流程（${(args?.steps ?? []).length} 步）`, kind: 'other' };
    },
  };

  const statusTool = {
    name: 'gui_status',
    description: '查询视觉点击的状态：是否被急停锁定、看门狗与输入进程在不在、OCR 能不能用、上一张截图多久了。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          armed: { type: 'boolean' },
          haltReason: { type: 'string' },
          allowControl: { type: 'boolean' },
          hotkey: { type: 'string' },
          watcherAlive: { type: 'boolean' },
          daemonAlive: { type: 'boolean' },
          ocr: { type: 'object', additionalProperties: true },
          lastCaptureAgeMs: { type: 'integer' },
          actions: { type: 'integer' },
          auditLog: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        return asText(value.message ?? '');
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      let ping = null;
      try {
        ping = await daemonRequest('ping', {}, { timeoutMs: 8000 });
      } catch {
        ping = null;
      }
      if (ping) {
        state.ocr.available = !!ping.ocr;
        state.ocr.languages = ping.languages ?? [];
        state.ocr.error = ping.ocrError ?? '';
      }

      const age = state.lastCapture ? Date.now() - state.lastCapture.at : null;
      const lines = [
        `状态：${state.armed ? 'armed（可用）' : `已锁定，原因：${state.haltReason || settings.emergencyHotkey}`}`,
        `急停快捷键：${settings.emergencyHotkey}（看门狗${watcherAlive ? '运行中' : '未运行'}）`,
        `输入/识图进程：${daemon?.alive ? '运行中' : '未运行'}`,
        `文字识别：${state.ocr.available ? `可用（${(state.ocr.languages ?? []).join(', ') || '默认语言'}）` : `不可用${state.ocr.error ? `：${state.ocr.error}` : ''}`}`,
        `上一张截图：${age == null ? '还没有' : `${(age / 1000).toFixed(1)} 秒前`}`,
        `本轮已执行动作：${state.actionCount} 次`,
        `审计日志：${auditFile}`,
      ];

      return {
        ok: true,
        armed: state.armed,
        haltReason: state.haltReason,
        allowControl: settings.allowControl,
        hotkey: settings.emergencyHotkey,
        watcherAlive,
        daemonAlive: !!daemon?.alive,
        ocr: { available: !!state.ocr.available, languages: state.ocr.languages ?? [], error: state.ocr.error },
        lastCaptureAgeMs: age ?? 0,
        actions: state.actionCount,
        auditLog: auditFile,
        message: lines.join('\n'),
      };
    },
  };

  const rearmTool = {
    name: 'gui_rearm',
    description:
      '在用户用急停快捷键强制停止之后，重新启用视觉点击。只有用户明确要求继续时才调用，必须传 confirm: true。',
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: '必须是 true' },
        note: { type: 'string', description: '为什么恢复，会写进审计日志' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, armed: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        return asText(value.message ?? '');
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertControlAllowed();
      if (args?.confirm !== true) {
        throw new Error('重新武装需要显式传 confirm: true，并且只在用户明确要求继续操作时调用。');
      }

      try {
        fs.rmSync(stopFile, { force: true });
      } catch {
        /* ignore */
      }

      stopSeenAt = 0;
      state.armed = true;
      state.haltedAt = 0;
      state.haltReason = '';
      state.lastAgentId = exec?.agent?.id ?? state.lastAgentId;

      if (!watcherAlive) {
        watcherRestarts = 0;
        startWatcher();
      }
      if (!daemon?.alive) startDaemon();

      audit({ action: 'rearm', agent: exec?.agent?.id, note: args?.note ?? null });
      return {
        ok: true,
        armed: true,
        message: '已重新武装。上一张截图已作废，请先 gui_look 再操作。',
      };
    },
  };

  const tools = [lookTool, clickTool, dragTool, scrollTool, typeTool, keyTool, waitTool, doTool, statusTool, rearmTool];

  // ------------------------------------------------------------------ lifecycle

  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool));
    startWatcher();
    ctx.logger?.info?.(
      `[vision-click] 已注册 ${tools.length} 个工具；急停 ${settings.emergencyHotkey}；OCR ${OCR_DLL}；目录 ${runtimeDir}`,
    );

    return () => {
      state.disposed = true;
      clearInterval(stopTimer);
      killDaemon('plugin dispose');
      try {
        watcher?.kill();
        watcher?.stdout?.destroy?.();
        watcher?.unref?.();
      } catch {
        /* already gone */
      }
      try {
        daemon?.child?.unref?.();
      } catch {
        /* already gone */
      }
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* already unregistered */
        }
      }
      ctx.logger?.info?.('[vision-click] 已卸载：输入进程与看门狗已停止');
    };
  });
}
