import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflow, defaultWorkflow, comfyUrl, DEFAULT_NEGATIVE } from './comfyui.ts';

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
