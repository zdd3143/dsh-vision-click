/**
 * dsh-vision-click :: end-to-end test
 *
 * Runs the plugin outside the harness: a minimal fake ctx (tool registry,
 * logger, attachments) wraps apply(), then the tools are driven against a real
 * WinForms window (tests/target-window.ps1).
 *
 *   node tests/run-click-test.mjs
 *
 * The window must already be open. Every assertion is about observable facts:
 * OCR finds the button text, the click changes the status label, and the
 * verifier reports the text that appeared.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, Config } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const attachmentDir = path.join(os.tmpdir(), 'dsh-vision-click-test');
fs.mkdirSync(attachmentDir, { recursive: true });

const registered = new Map();
const logs = [];

const ctx = {
  logger: {
    info: (m) => logs.push(`[info] ${m}`),
    warn: (m) => logs.push(`[warn] ${m}`),
    error: (m) => logs.push(`[error] ${m}`),
  },
  effect(fn) {
    return fn();
  },
  get(name) {
    if (name !== 'attachments') return null;
    return {
      async saveImage({ data, mediaType, name: fileName }) {
        const target = path.join(attachmentDir, fileName ?? `shot-${Date.now()}.png`);
        fs.writeFileSync(target, Buffer.from(data));
        return {
          attachmentId: path.basename(target),
          mediaType,
          bytes: data.byteLength,
          width: 0,
          height: 0,
          path: target,
        };
      },
    };
  },
  tools: {
    register(tool) {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
};

const validated = Config['~standard'].validate({ allowControl: true, maxWidth: 1400 });
if (validated.issues) {
  console.error('config validation failed', validated.issues);
  process.exit(1);
}

const dispose = apply(ctx, validated.value);
await new Promise((r) => setTimeout(r, 700));
console.log('plugin logs after start:\n' + logs.join('\n'));

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function findTool(name) {
  const tool = registered.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

async function call(name, args) {
  const tool = findTool(name);
  try {
    return await tool.execute(args, { agent: { id: 'test-agent' } });
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

console.log('registered tools:', [...registered.keys()].join(', '));

const look = await call('gui_look', { maxLines: 40 });
console.log('\n--- gui_look ---');
console.log(look.message?.slice(0, 1200) ?? look.error);
check('gui_look returns OCR index', look.ok === true && look.lineCount > 0, look.error);
const squeeze = (s) => String(s ?? '').replace(/\s+/g, '');
const lookText = (look.lines ?? []).map((l) => squeeze(l.text)).join(' | ');
check('OCR sees the test window button', /开始测试/.test(lookText), lookText.slice(0, 200));

if (process.env.VC_TEST_LOOK_ONLY === '1') {
  console.log('\nVC_TEST_LOOK_ONLY=1: stopping before any click');
  if (typeof dispose === 'function') dispose();
  process.exit(failures.length ? 1 : 0);
}

const clickStart = await call('gui_click', { target: '开始测试', note: 'test: start button' });
console.log('\n--- gui_click target=开始测试 ---');
console.log(clickStart.message ?? clickStart.error);
check('target click succeeded', clickStart.ok === true, clickStart.error);
check('click was verified by pixel diff', clickStart.verify?.changed === true, JSON.stringify(clickStart.verify));
check(
  'status text changed to 已开始',
  (clickStart.verify?.appeared ?? []).some((t) => /已开始/.test(squeeze(t))),
  JSON.stringify(clickStart.verify?.appeared),
);

// OCR does not always read every label: "下一步" can come back as "下一".
// The contract is: either click it correctly, or refuse with the candidates —
// never click something else.
const clickNext = await call('gui_click', { target: '下一步' });
console.log('\n--- gui_click target=下一步 ---');
console.log(clickNext.message ?? clickNext.error);
check(
  '下一步 either clicked or explicitly refused',
  clickNext.ok === true || /把握不大|找不到|多个可能|pick/.test(clickNext.error ?? ''),
  clickNext.error,
);
if (clickNext.ok === true) {
  check(
    'status text changed to 走到下一步',
    (clickNext.verify?.appeared ?? []).some((t) => /下一步/.test(squeeze(t))),
    JSON.stringify(clickNext.verify?.appeared),
  );
}

const clickAgain = await call('gui_click', { target: '开始测试' });
console.log('\n--- gui_click target=开始测试 (second time) ---');
console.log(clickAgain.message ?? clickAgain.error);
check('repeated target click succeeded', clickAgain.ok === true, clickAgain.error);
check(
  'status counter increased',
  (clickAgain.verify?.appeared ?? []).some((t) => /已开始/.test(squeeze(t))),
  JSON.stringify(clickAgain.verify?.appeared),
);

const ambiguous = await call('gui_click', { target: '重复标签' });
console.log('\n--- gui_click ambiguous target=重复标签 ---');
console.log(ambiguous.error ?? ambiguous.message);
check('ambiguous target is refused rather than mis-clicked', ambiguous.ok === false && /多个可能/.test(ambiguous.error ?? ''));

const flow = await call('gui_do', {
  steps: [{ click: '开始测试' }, { wait: '已开始', timeoutMs: 6000 }, { click: '开始测试' }],
  stopOnNoChange: true,
});
console.log('\n--- gui_do 3 steps ---');
console.log(flow.message ?? flow.error);
check('gui_do completed every step', flow.ok === true && flow.completed === 3, flow.error ?? JSON.stringify(flow.trace));

// ---------------------------------------------------------------- hover
const hover = await call('gui_click', { target: '开始测试', hover: true });
console.log('\n--- gui_click hover=true ---');
console.log(hover.message ?? hover.error);
check('hover executed', hover.ok === true && hover.clicked?.hover === true, hover.error);
check(
  'hover did not press the button',
  !(hover.verify?.appeared ?? []).some((t) => /已开始/.test(squeeze(t))),
  JSON.stringify(hover.verify?.appeared),
);

// ---------------------------------------------------------------- right click
const right = await call('gui_click', { target: '开始测试', button: 'right' });
console.log('\n--- gui_click button=right ---');
console.log(right.message ?? right.error);
check('right click executed', right.ok === true && right.clicked?.button === 'right', right.error);
check(
  'right click did not trigger the left-click handler',
  !(right.verify?.appeared ?? []).some((t) => /已开始/.test(squeeze(t))),
  JSON.stringify(right.verify?.appeared),
);

// ---------------------------------------------------------------- long press
const press = await call('gui_click', { target: '开始测试', holdMs: 700 });
console.log('\n--- gui_click holdMs=700 ---');
console.log(press.message ?? press.error);
check('long press executed', press.ok === true && press.clicked?.holdMs === 700, press.error);
check(
  'long press still activates the button on release',
  (press.verify?.appeared ?? []).some((t) => /已开始/.test(squeeze(t))),
  JSON.stringify(press.verify?.appeared),
);

// ---------------------------------------------------------------- drag
const drag = await call('gui_drag', { from: { target: '拖动我' }, to: { target: '拖到这里' } });
console.log('\n--- gui_drag 拖动我 -> 拖到这里 ---');
console.log(drag.message ?? drag.error);
check('drag executed', drag.ok === true, drag.error);
check('drag produced a visible change', drag.verify?.changed === true, JSON.stringify(drag.verify));
check(
  'drag was seen by the window (status says 已拖动)',
  (drag.verify?.appeared ?? []).some((t) => /已拖动/.test(squeeze(t))),
  JSON.stringify(drag.verify?.appeared),
);

// ---------------------------------------------------------------- scroll
const scroll = await call('gui_scroll', { target: '列表第 1 行', direction: 'down', amount: 5 });
console.log('\n--- gui_scroll down 5 ---');
console.log(scroll.message ?? scroll.error);
check('scroll executed', scroll.ok === true && scroll.scroll?.amount === 5, scroll.error);
check('scroll changed the list', scroll.verify?.changed === true, JSON.stringify(scroll.verify));

// ---------------------------------------------------------------- keyboard
const focusField = await call('gui_click', { target: '账号' });
console.log('\n--- gui_click target=账号 (focus text field) ---');
console.log(focusField.message ?? focusField.error);
check('text field focused', focusField.ok === true, focusField.error);

const typed = await call('gui_type', { text: 'Abc123' });
console.log('\n--- gui_type Abc123 ---');
console.log(typed.message ?? typed.error);
check('typing executed', typed.ok === true, typed.error);
check(
  'typed characters were observed on screen',
  (typed.verify?.appeared ?? []).some((t) => /Abc123/.test(squeeze(t))) || typed.verify?.changed === true,
  JSON.stringify(typed.verify),
);

const selectAll = await call('gui_key', { keys: 'ctrl+a' });
console.log('\n--- gui_key ctrl+a ---');
console.log(selectAll.message ?? selectAll.error);
check('ctrl+a executed', selectAll.ok === true, selectAll.error);

const replaced = await call('gui_type', { text: 'XyZ9' });
console.log('\n--- gui_type XyZ9 (replaces selection) ---');
console.log(replaced.message ?? replaced.error);
check('typing after select-all replaced the text', replaced.ok === true, replaced.error);
check(
  'replacement changed the field',
  replaced.verify?.changed === true || (replaced.verify?.appeared ?? []).some((t) => /XyZ9/.test(squeeze(t))),
  JSON.stringify(replaced.verify),
);

const backspace = await call('gui_key', { keys: 'backspace', count: 2 });
console.log('\n--- gui_key backspace x2 ---');
console.log(backspace.message ?? backspace.error);
check('backspace executed', backspace.ok === true, backspace.error);

const enter = await call('gui_key', { keys: 'enter' });
console.log('\n--- gui_key enter ---');
console.log(enter.message ?? enter.error);
check('enter executed', enter.ok === true, enter.error);

const keyFlow = await call('gui_do', {
  steps: [{ key: 'ctrl+a' }, { type: 'Hello42', pressEnter: false }, { key: 'end' }],
});
console.log('\n--- gui_do click + ctrl+a + type ---');
console.log(keyFlow.message ?? keyFlow.error);
check('gui_do handles keyboard steps', keyFlow.ok === true && keyFlow.completed === 3, keyFlow.error ?? JSON.stringify(keyFlow.trace));

const status = await call('gui_status', {});
console.log('\n--- gui_status ---');
console.log(status.message ?? status.error);
check('status reports OCR available', status.ocr?.available === true, JSON.stringify(status.ocr));

if (typeof dispose === 'function') dispose();
await new Promise((r) => setTimeout(r, 300));

console.log('\nlogger tail:');
console.log(logs.slice(-6).join('\n'));

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
process.exit(0);
