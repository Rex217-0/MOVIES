import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkflow, defaultWorkflow, comfyUrl, DEFAULT_NEGATIVE,
  clampStrength, publishLora, listLoras, lorasDir,
  buildVideoWorkflow, comfyVideoConfigured,
  unfilledPlaceholders, VIDEO_PLACEHOLDERS, diagnoseComfyVideo,
} from './comfyui.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockComfyUI } from '../testing/comfyuiMock.ts';

test('comfyUrl defaults to localhost and strips trailing slashes', () => {
  const saved = process.env.COMFYUI_URL;
  delete process.env.COMFYUI_URL;
  assert.equal(comfyUrl(), 'http://127.0.0.1:8188');
  process.env.COMFYUI_URL = 'http://192.168.1.50:8188/';
  assert.equal(comfyUrl(), 'http://192.168.1.50:8188');
  if (saved === undefined) delete process.env.COMFYUI_URL;
  else process.env.COMFYUI_URL = saved;
});

test('the default workflow is a valid ComfyUI API graph', () => {
  const wf: any = defaultWorkflow('a cat', 'blurry', 42, 1024, 1024, 'model.safetensors');
  const nodes = Object.values<any>(wf);
  assert.ok(nodes.every(n => typeof n.class_type === 'string'));
  assert.equal(wf['3'].inputs.seed, 42);
  assert.equal(wf['6'].inputs.text, 'a cat');
  assert.equal(wf['7'].inputs.text, 'blurry');
  assert.equal(wf['4'].inputs.ckpt_name, 'model.safetensors');
  // KSampler must reference the loader, both text encoders, and the latent.
  assert.deepEqual(wf['3'].inputs.model, ['4', 0]);
  assert.deepEqual(wf['3'].inputs.positive, ['6', 0]);
  assert.deepEqual(wf['3'].inputs.negative, ['7', 0]);
});

test('buildWorkflow falls back to the default graph with no template', () => {
  const saved = process.env.COMFYUI_WORKFLOW;
  delete process.env.COMFYUI_WORKFLOW;
  const wf: any = buildWorkflow('hello', { seed: 7 });
  assert.equal(wf['6'].inputs.text, 'hello');
  assert.equal(wf['3'].inputs.seed, 7);
  assert.equal(wf['7'].inputs.text, DEFAULT_NEGATIVE);
  if (saved !== undefined) process.env.COMFYUI_WORKFLOW = saved;
});


test('a chosen LoRA adds a LoraLoader node and reroutes model and clip', () => {
  const wf: any = defaultWorkflow('a cat', 'blurry', 1, 1024, 1024, 'base.safetensors', {
    name: 'direk_x.safetensors',
    strength: 0.8,
  });
  assert.equal(wf['10'].class_type, 'LoraLoader');
  assert.equal(wf['10'].inputs.lora_name, 'direk_x.safetensors');
  assert.equal(wf['10'].inputs.strength_model, 0.8);
  assert.equal(wf['10'].inputs.strength_clip, 0.8);
  // The sampler now reads the LoRA's model, not the checkpoint's.
  assert.deepEqual(wf['3'].inputs.model, ['10', 0]);
  assert.deepEqual(wf['6'].inputs.clip, ['10', 1]);
  assert.deepEqual(wf['7'].inputs.clip, ['10', 1]);
});

test('without a LoRA the graph has no loader node', () => {
  const wf: any = buildWorkflow('x', { seed: 1 });
  assert.equal(wf['10'], undefined);
  assert.deepEqual(wf['3'].inputs.model, ['4', 0]);
});

test('clampStrength keeps the blend in a sane range', () => {
  assert.equal(clampStrength(undefined), 1);
  assert.equal(clampStrength('0.75'), 0.75);
  assert.equal(clampStrength(9), 2);
  assert.equal(clampStrength(-9), -2);
});

test('publishLora copies the file and listLoras finds it', () => {
  const saved = process.env.COMFYUI_LORAS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loras-'));
  process.env.COMFYUI_LORAS_DIR = dir;
  try {
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'run-')), 'my_lora.safetensors');
    fs.writeFileSync(src, 'weights');
    const published = publishLora(src);
    assert.equal(published.name, 'my_lora.safetensors');
    assert.equal(published.bytes, 7);
    assert.equal(lorasDir(), dir);
    assert.deepEqual(listLoras().map(l => l.name), ['my_lora.safetensors']);
  } finally {
    if (saved === undefined) delete process.env.COMFYUI_LORAS_DIR;
    else process.env.COMFYUI_LORAS_DIR = saved;
  }
});

test('the workflow template receives the LoRA placeholders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const tpl = path.join(dir, 'wf.json');
  fs.writeFileSync(tpl, JSON.stringify({ node: { lora: '__LORA__', s: '__LORA_STRENGTH__' } }));
  const savedWf = process.env.COMFYUI_WORKFLOW;
  process.env.COMFYUI_WORKFLOW = tpl;
  try {
    const wf: any = buildWorkflow('p', { lora: { name: 'a.safetensors', strength: 0.5 } });
    assert.equal(wf.node.lora, 'a.safetensors');
    assert.equal(wf.node.s, '0.5');
  } finally {
    if (savedWf === undefined) delete process.env.COMFYUI_WORKFLOW;
    else process.env.COMFYUI_WORKFLOW = savedWf;
  }
});

test('comfyVideoConfigured is false without a workflow, true with one', () => {
  const saved = process.env.COMFYUI_VIDEO_WORKFLOW;
  delete process.env.COMFYUI_VIDEO_WORKFLOW;
  assert.equal(comfyVideoConfigured(), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const tpl = path.join(dir, 'vid.json');
  fs.writeFileSync(tpl, JSON.stringify({ n: { p: '__PROMPT__', f: '__FRAMES__' } }));
  process.env.COMFYUI_VIDEO_WORKFLOW = tpl;
  try {
    assert.equal(comfyVideoConfigured(), true);
  } finally {
    if (saved === undefined) delete process.env.COMFYUI_VIDEO_WORKFLOW;
    else process.env.COMFYUI_VIDEO_WORKFLOW = saved;
  }
});

test('buildVideoWorkflow fills the video placeholders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const tpl = path.join(dir, 'vid.json');
  fs.writeFileSync(tpl, JSON.stringify({ n: { p: '__PROMPT__', f: '__FRAMES__', w: '__WIDTH__' } }));
  const saved = process.env.COMFYUI_VIDEO_WORKFLOW;
  process.env.COMFYUI_VIDEO_WORKFLOW = tpl;
  try {
    const wf: any = buildVideoWorkflow('a sunset', { frames: 25, width: 512 });
    assert.equal(wf.n.p, 'a sunset');
    assert.equal(wf.n.f, '25');
    assert.equal(wf.n.w, '512');
  } finally {
    if (saved === undefined) delete process.env.COMFYUI_VIDEO_WORKFLOW;
    else process.env.COMFYUI_VIDEO_WORKFLOW = saved;
  }
});

test('buildVideoWorkflow explains itself when no workflow is configured', () => {
  const saved = process.env.COMFYUI_VIDEO_WORKFLOW;
  delete process.env.COMFYUI_VIDEO_WORKFLOW;
  try {
    assert.throws(() => buildVideoWorkflow('x'), /COMFYUI_VIDEO_WORKFLOW/);
  } finally {
    if (saved === undefined) delete process.env.COMFYUI_VIDEO_WORKFLOW;
    else process.env.COMFYUI_VIDEO_WORKFLOW = saved;
  }
});

test('unfilledPlaceholders flags unknown tokens and ignores the known ones', () => {
  // A template that uses only supported placeholders is clean.
  assert.deepEqual(unfilledPlaceholders(JSON.stringify({ p: '__PROMPT__', f: '__FRAMES__' })), []);
  // A token the builder cannot fill is reported once, deduped.
  assert.deepEqual(
    unfilledPlaceholders('__BATCH__ and __BATCH__ and __STEPS__'),
    ['__BATCH__', '__STEPS__'],
  );
});

test('buildVideoWorkflow refuses a template with an unfilled placeholder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const tpl = path.join(dir, 'vid.json');
  fs.writeFileSync(tpl, JSON.stringify({ n: { p: '__PROMPT__', b: '__BATCH__' } }));
  const saved = process.env.COMFYUI_VIDEO_WORKFLOW;
  process.env.COMFYUI_VIDEO_WORKFLOW = tpl;
  try {
    assert.throws(() => buildVideoWorkflow('x'), /__BATCH__/);
  } finally {
    if (saved === undefined) delete process.env.COMFYUI_VIDEO_WORKFLOW;
    else process.env.COMFYUI_VIDEO_WORKFLOW = saved;
  }
});

test('buildVideoWorkflow reports a missing workflow file', () => {
  const saved = process.env.COMFYUI_VIDEO_WORKFLOW;
  process.env.COMFYUI_VIDEO_WORKFLOW = path.join(os.tmpdir(), 'no-such-video-workflow.json');
  try {
    assert.throws(() => buildVideoWorkflow('x'), /Walang workflow file/);
  } finally {
    if (saved === undefined) delete process.env.COMFYUI_VIDEO_WORKFLOW;
    else process.env.COMFYUI_VIDEO_WORKFLOW = saved;
  }
});

test('every known video placeholder is substituted before the graph is built', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const tpl = path.join(dir, 'vid.json');
  fs.writeFileSync(tpl, JSON.stringify({
    p: '__PROMPT__', n: '__NEGATIVE__', s: '__SEED__', w: '__WIDTH__', h: '__HEIGHT__',
    f: '__FRAMES__', c: '__CHECKPOINT__',
  }));
  const saved = process.env.COMFYUI_VIDEO_WORKFLOW;
  const savedCkpt = process.env.COMFYUI_CHECKPOINT;
  process.env.COMFYUI_VIDEO_WORKFLOW = tpl;
  process.env.COMFYUI_CHECKPOINT = 'sdxl.safetensors';
  try {
    const wf: any = buildVideoWorkflow('a sunset', { seed: 7, width: 640, height: 360, frames: 25 });
    assert.equal(wf.p, 'a sunset');
    assert.equal(wf.s, '7');
    assert.equal(wf.w, '640');
    assert.equal(wf.h, '360');
    assert.equal(wf.f, '25');
    assert.equal(wf.c, 'sdxl.safetensors');
    // No placeholder token survives into the graph sent to ComfyUI.
    for (const value of Object.values(wf)) {
      assert.doesNotMatch(String(value), /__[A-Z0-9_]+__/);
    }
    assert.equal(VIDEO_PLACEHOLDERS.length, 7);
  } finally {
    if (saved === undefined) delete process.env.COMFYUI_VIDEO_WORKFLOW;
    else process.env.COMFYUI_VIDEO_WORKFLOW = saved;
    if (savedCkpt === undefined) delete process.env.COMFYUI_CHECKPOINT;
    else process.env.COMFYUI_CHECKPOINT = savedCkpt;
  }
});

/** Run `fn` with the video environment replaced, then restore it. */
async function withVideoEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const keys = ['COMFYUI_URL', 'COMFYUI_VIDEO_WORKFLOW', 'COMFYUI_DISABLE'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('diagnoseComfyVideo names each reason the backend is not usable', async () => {
  // Disabled.
  await withVideoEnv({ COMFYUI_DISABLE: '1' }, async () => {
    const d = await diagnoseComfyVideo();
    assert.equal(d.problem, 'disabled');
    assert.equal(d.ready, false);
  });

  // No workflow configured.
  await withVideoEnv({}, async () => {
    const d = await diagnoseComfyVideo();
    assert.equal(d.problem, 'no-workflow');
    assert.equal(d.ready, false);
  });

  // Workflow path set but the file is missing.
  await withVideoEnv({ COMFYUI_VIDEO_WORKFLOW: '/no/such/workflow.json' }, async () => {
    const d = await diagnoseComfyVideo();
    assert.equal(d.problem, 'workflow-missing');
    assert.equal(d.workflow_exists, false);
  });

  // A workflow with a placeholder the builder cannot fill.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const tpl = path.join(dir, 'vid.json');
  fs.writeFileSync(tpl, JSON.stringify({ p: '__PROMPT__', b: '__BATCH__' }));
  await withVideoEnv({ COMFYUI_VIDEO_WORKFLOW: tpl }, async () => {
    const d = await diagnoseComfyVideo();
    assert.equal(d.problem, 'placeholder');
    assert.deepEqual(d.unfilled, ['__BATCH__']);
  });
});

test('diagnoseComfyVideo reports unreachable when nothing answers, ready when the mock does', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const tpl = path.join(dir, 'vid.json');
  fs.writeFileSync(tpl, JSON.stringify({ p: '__PROMPT__', f: '__FRAMES__' }));

  // A port nothing listens on -> unreachable.
  await withVideoEnv({ COMFYUI_URL: 'http://127.0.0.1:1', COMFYUI_VIDEO_WORKFLOW: tpl }, async () => {
    const d = await diagnoseComfyVideo();
    assert.equal(d.problem, 'unreachable');
    assert.equal(d.ready, false);
  });

  // A real mock server -> ready.
  const mock = await startMockComfyUI();
  try {
    await withVideoEnv({ COMFYUI_URL: mock.url, COMFYUI_VIDEO_WORKFLOW: tpl }, async () => {
      const d = await diagnoseComfyVideo();
      assert.equal(d.problem, 'ready');
      assert.equal(d.ready, true);
      assert.equal(d.reachable, true);
    });
  } finally {
    await mock.close();
  }
});
