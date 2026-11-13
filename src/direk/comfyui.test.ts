import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkflow, defaultWorkflow, comfyUrl, DEFAULT_NEGATIVE,
  clampStrength, publishLora, listLoras, lorasDir,
} from './comfyui.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
