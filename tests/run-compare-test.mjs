/**
 * dsh-vision-click :: OCR-only vs OCR+vision comparison
 *
 * Runs the same 5-step task against tests/complex-window.ps1 twice:
 *   1) visionEnabled: false  — pure OCR
 *   2) visionEnabled: true   — vision fallback (UI-TARS via Ollama)
 *
 * Each step is judged by an observable status line, not by "the call returned".
 *
 *   powershell -File tests/complex-window.ps1     # first, keep it in front
 *   node tests/run-compare-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, Config } from '../index.js';

const attachmentDir = path.join(os.tmpdir(), 'dsh-vision-click-compare');
fs.mkdirSync(attachmentDir, { recursive: true });

function makeCtx() {
  const registered = new Map();
  const logs = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    effect(fn) {
      return fn();
    },
    get(name) {
      if (name !== 'attachments') return null;
      return {
        async saveImage({ data, mediaType, name }) {
          const target = path.join(attachmentDir, name ?? `s-${Date.now()}.png`);
          fs.writeFileSync(target, Buffer.from(data));
          return { attachmentId: path.basename(target), mediaType, bytes: data.byteLength, width: 0, height: 0, path: target };
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
  return { ctx, registered };
}

async function callTool(registered, name, args) {
  const tool = registered.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return await tool.execute(args, { agent: { id: 'compare' } });
}

/** Wait until the status line contains `text`, using the plugin's own OCR wait. */
async function expectStatus(registered, text, timeoutMs = 5000) {
  const res = await callTool(registered, 'gui_wait', { target: text, timeoutMs, query: '状态' });
  return { ok: res.ok === true && res.matched === true, detail: res.message };
}

const steps = [
  {
    name: '点齿轮图标（画布，无文字）',
    expect: '齿轮图标',
    run: (r) => callTool(r, 'gui_click', { target: 'the blue gear icon in the top right' }),
    visionOnly: true,
  },
  {
    name: '点低对比度小字',
    expect: '低对比度文字',
    run: (r) => callTool(r, 'gui_click', { target: '低对比度目标' }),
  },
  {
    name: '把方块拖到目标区',
    expect: '已拖动到',
    run: (r) => callTool(r, 'gui_drag', { from: { target: '拖动我' }, to: { target: '目标区' } }),
  },
  {
    name: '列表滚到底并点第 40 行',
    expect: '选中第 40 行',
    run: async (r) => {
      await callTool(r, 'gui_scroll', { target: '列表第 1 行', direction: 'down', amount: 20 });
      const seen = await callTool(r, 'gui_wait', { target: '列表第 40 行', timeoutMs: 4000 });
      if (!seen.matched) {
        await callTool(r, 'gui_scroll', { target: '列表第 1 行', direction: 'down', amount: 10 });
      }
      return callTool(r, 'gui_click', { target: '列表第 40 行' });
    },
  },
  {
    name: '点提交',
    expect: '已提交',
    run: (r) => callTool(r, 'gui_click', { target: '提交' }),
  },
];

async function runVariant(visionEnabled) {
  const { ctx, registered } = makeCtx();
  const config = Config['~standard'].validate({
    allowControl: true,
    maxWidth: 1400,
    visionEnabled,
    visionMode: 'fallback',
    visionModel: process.env.VISION_MODEL ?? 'ui-tars:7b',
    visionBaseUrl: process.env.VISION_BASE ?? 'http://127.0.0.1:11434',
    visionTimeoutMs: 40000,
  });
  const dispose = apply(ctx, config.value);
  await new Promise((r) => setTimeout(r, 500));

  // reset the fixture so both runs start from the same state
  try {
    await callTool(registered, 'gui_click', { target: '重置', textCheck: false });
  } catch {
    /* reset is best effort */
  }

  const results = [];
  for (const step of steps) {
    const t0 = Date.now();
    let callOk = false;
    let callError = '';
    let visionUsed = false;
    try {
      const res = await step.run(registered);
      callOk = res?.ok !== false;
      visionUsed = res?.source === 'vision';
      if (res?.error) callError = res.error;
    } catch (error) {
      callError = String(error?.message ?? error);
    }
    const elapsed = Date.now() - t0;

    let observed = false;
    try {
      const status = await expectStatus(registered, step.expect, 5000);
      observed = status.ok;
    } catch {
      observed = false;
    }

    results.push({
      name: step.name,
      ok: callOk && observed,
      callOk,
      observed,
      visionUsed,
      ms: elapsed,
      error: callError.split('\n')[0].slice(0, 120),
    });
    console.log(
      `  ${callOk && observed ? 'PASS' : 'FAIL'}  ${step.name}  (${elapsed}ms${visionUsed ? ', vision' : ''})` +
        `${callOk && observed ? '' : `  -> ${callError || 'status not observed'}`}`,
    );
  }

  if (typeof dispose === 'function') dispose();
  await new Promise((r) => setTimeout(r, 400));
  return results;
}

console.log('=== variant A: OCR only (visionEnabled: false) ===');
const a = await runVariant(false);

console.log('\n=== variant B: OCR + vision fallback (visionEnabled: true) ===');
const b = await runVariant(true);

const pad = (s, n) => String(s).padEnd(n);
console.log('\n=== comparison ===');
console.log(pad('step', 34) + pad('ocr', 8) + pad('ocr+vision', 12) + 'vision used');
for (let i = 0; i < steps.length; i++) {
  console.log(pad(steps[i].name, 34) + pad(a[i].ok ? `PASS` : 'FAIL', 8) + pad(b[i].ok ? 'PASS' : 'FAIL', 12) + (b[i].visionUsed ? 'yes' : 'no'));
}
const sum = (xs) => xs.reduce((acc, x) => acc + x.ms, 0);
console.log(pad('total', 34) + pad(`${a.filter((x) => x.ok).length}/5`, 8) + pad(`${b.filter((x) => x.ok).length}/5`, 12) + '');
console.log(pad('wall time', 34) + pad(`${(sum(a) / 1000).toFixed(1)}s`, 8) + pad(`${(sum(b) / 1000).toFixed(1)}s`, 12) + '');

const aFail = a.filter((x) => !x.ok).map((x) => x.name);
const bFail = b.filter((x) => !x.ok).map((x) => x.name);
console.log('\nOCR-only failures:', aFail.length ? aFail.join(' / ') : 'none');
console.log('OCR+vision failures:', bFail.length ? bFail.join(' / ') : 'none');

process.exit(0);
