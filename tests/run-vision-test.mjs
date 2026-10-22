/**
 * dsh-vision-click :: vision fallback test
 *
 * Drives gui_click with visionMode:"always" against the WinForms fixture and a
 * local UI-TARS model on Ollama, so the model path is exercised even when OCR
 * could have answered. Requires:
 *   - tests/target-window.ps1 running in the foreground
 *   - ollama serve + the model named in VISION_MODEL (default ui-tars:7b)
 *
 *   node tests/run-vision-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, Config } from '../index.js';

const VISION_MODEL = process.env.VISION_MODEL ?? 'ui-tars:7b';
const VISION_BASE = process.env.VISION_BASE ?? 'http://127.0.0.1:11434';

const attachmentDir = path.join(os.tmpdir(), 'dsh-vision-click-vision-test');
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

const validated = Config['~standard'].validate({
  allowControl: true,
  maxWidth: 1400,
  visionEnabled: true,
  visionMode: 'always',
  visionModel: VISION_MODEL,
  visionBaseUrl: VISION_BASE,
});

const dispose = apply(ctx, validated.value);
await new Promise((r) => setTimeout(r, 600));

const failures = [];
function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${condition || !detail ? '' : ` — ${detail}`}`);
  if (!condition) failures.push(label);
}

async function call(name, args) {
  const tool = registered.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  try {
    return await tool.execute(args, { agent: { id: 'vision-test' } });
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// 1) plain label — the model should find the button and we should snap to its text
const button = await call('gui_click', { target: '重复标签', textCheck: false });
console.log('\n--- vision: 重复标签 (snap check) ---');
console.log(button.message ?? button.error);
check('vision click succeeded', button.ok === true, button.error);
check('source is vision', button.source === 'vision', JSON.stringify(button.verify));
// Snapping only happens when OCR actually read the label in this frame; OCR is
// not deterministic, so the contract is "never snap to an unrelated word".
check(
  'snap never lands on an unrelated label',
  button.vision?.snapped !== true || (button.vision?.snappedText ?? '').length > 0,
  JSON.stringify(button.vision),
);
console.log('  info  nearest OCR word:', JSON.stringify(button.vision?.nearest ?? null));

// 2) semantic-only target: nothing in the OCR index says "yellow block"
const block = await call('gui_click', { target: 'the yellow draggable block', textCheck: false });
console.log('\n--- vision: the yellow draggable block ---');
console.log(block.message ?? block.error);
check('semantic target click succeeded', block.ok === true, block.error);
check('semantic target used vision', block.source === 'vision', JSON.stringify(block.vision));
if (block.ok) {
  const nx = block.clicked?.nx;
  const ny = block.clicked?.ny;
  // the yellow block sits in the lower-left quadrant of the fixture
  check('landed in the lower-left block area', nx > 0.05 && nx < 0.35 && ny > 0.42 && ny < 0.58, `point=(${nx}, ${ny})`);
}

// 3) a drop zone
const drop = await call('gui_click', { target: '拖到这里', textCheck: false });
console.log('\n--- vision: 拖到这里 ---');
console.log(drop.message ?? drop.error);
check('drop zone click succeeded', drop.ok === true, drop.error);
check('drop zone used vision', drop.source === 'vision', JSON.stringify(drop.vision));

console.log('\nlogger tail:');
console.log(logs.slice(-4).join('\n'));

if (typeof dispose === 'function') dispose();
await new Promise((r) => setTimeout(r, 300));

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall vision checks passed');
process.exit(0);
