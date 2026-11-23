/**
 * Real tests for the Wan 2.2 connector.
 *
 * A local HTTP server speaks the three ComfyUI endpoints the connector uses
 * (/system_stats, /object_info/UNETLoader, /object_info/CLIPLoader,
 * /object_info/VAELoader) and answers with the same shapes ComfyUI does. The
 * template under test is the real `workflows/wan22_video_api.json`, so a change
 * to that graph breaks these tests instead of silently breaking Server-2.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkWan22Status,
  comfyLoaderOptions,
  loadWan22Graph,
  wan22Models,
  wan22WorkflowPath,
} from './wan22Connector.ts';

interface Comfy {
  base: string;
  close: () => Promise<void>;
  calls: string[];
}

/** A ComfyUI-shaped server. `models` is what each loader claims to offer. */
function startComfy(models: { unet: string[]; clip: string[]; vae: string[] }, opts: { up?: boolean } = {}): Promise<Comfy> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    calls.push(url.pathname);
    if (opts.up === false) {
      res.writeHead(503);
      res.end('down');
      return;
    }
    const json = (payload: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/system_stats') {
      json({ system: { os: 'posix' }, devices: [{ name: 'cuda:0', vram_total: 24e9 }] });
      return;
    }
    const loader = url.pathname.replace('/object_info/', '');
    const table: Record<string, [string, string[]]> = {
      UNETLoader: ['unet_name', models.unet],
      CLIPLoader: ['clip_name', models.clip],
      VAELoader: ['vae_name', models.vae],
    };
    const entry = table[loader];
    if (!entry) {
      res.writeHead(404);
      res.end('no such node');
      return;
    }
    json({ [loader]: { input: { required: { [entry[0]]: [entry[1], {}] } } } });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
        calls,
      });
    });
  });
}

const ALL_MODELS = {
  unet: ['wan2.2_ti2v_5B_fp16.safetensors'],
  clip: ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'],
  vae: ['wan2.2_vae.safetensors'],
};

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> | T {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore);
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Model names
// ---------------------------------------------------------------------------

test('the default model names are exactly the ones in the workflow', () => {
  const models = wan22Models();
  assert.equal(models.unet, 'wan2.2_ti2v_5B_fp16.safetensors');
  assert.equal(models.clip, 'umt5_xxl_fp8_e4m3fn_scaled.safetensors');
  assert.equal(models.vae, 'wan2.2_vae.safetensors');
});

test('the defaults match the shipped template, so a fresh clone renders', () => {
  const models = wan22Models();
  const raw = fs.readFileSync(path.join(process.cwd(), 'workflows', 'wan22_video_api.json'), 'utf8');
  assert.ok(raw.includes(models.unet), 'unet default must exist in the template');
  assert.ok(raw.includes(models.clip), 'clip default must exist in the template');
  assert.ok(raw.includes(models.vae), 'vae default must exist in the template');
});

test('every model name is overridable from the environment', () => withEnv({
  COMFYUI_MODEL_WAN22: 'wan2.2_ti2v_5B_fp8.safetensors',
  COMFYUI_CLIP_WAN22: 'umt5_custom.safetensors',
  COMFYUI_VAE_WAN22: 'custom_vae.safetensors',
}, () => {
  const models = wan22Models();
  assert.equal(models.unet, 'wan2.2_ti2v_5B_fp8.safetensors');
  assert.equal(models.clip, 'umt5_custom.safetensors');
  assert.equal(models.vae, 'custom_vae.safetensors');
}));

// ---------------------------------------------------------------------------
// Graph loading
// ---------------------------------------------------------------------------

test('the real template has all three loaders and they are filled in', () => {
  const { graph, applied } = loadWan22Graph();
  assert.deepEqual(applied, { unet: true, clip: true, vae: true });

  const nodes = Object.values(graph) as any[];
  const unet = nodes.find(n => n.class_type === 'UNETLoader');
  const clip = nodes.find(n => n.class_type === 'CLIPLoader');
  const vae = nodes.find(n => n.class_type === 'VAELoader');
  assert.equal(unet.inputs.unet_name, 'wan2.2_ti2v_5B_fp16.safetensors');
  assert.equal(clip.inputs.clip_name, 'umt5_xxl_fp8_e4m3fn_scaled.safetensors');
  assert.equal(vae.inputs.vae_name, 'wan2.2_vae.safetensors');
});

test('an env override lands in the graph, not just in the status report', () => withEnv({
  COMFYUI_MODEL_WAN22: 'wan2.2_ti2v_5B_fp8.safetensors',
}, () => {
  const { graph } = loadWan22Graph();
  const unet = (Object.values(graph) as any[]).find(n => n.class_type === 'UNETLoader');
  assert.equal(unet.inputs.unet_name, 'wan2.2_ti2v_5B_fp8.safetensors');
}));

test('the prompt and seed placeholders are left for the render builder', () => {
  const { graph } = loadWan22Graph();
  const nodes = Object.values(graph) as any[];
  const positive = nodes.find(n => n.class_type === 'CLIPTextEncode' && n.inputs.text === '__PROMPT__');
  const sampler = nodes.find(n => n.class_type === 'KSampler' && n.inputs.seed === '__SEED__');
  assert.ok(positive, 'the prompt placeholder must survive model substitution');
  assert.ok(sampler, 'the seed placeholder must survive model substitution');
});

test('a template without a loader is refused with the missing name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wan22-'));
  try {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ 1: { class_type: 'UNETLoader', inputs: { unet_name: 'x' } } }));
    assert.throws(() => loadWan22Graph(wan22Models(), file), /CLIPLoader.*VAELoader|Kulang/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing template names the path instead of a bare ENOENT', () => {
  assert.throws(() => loadWan22Graph(wan22Models(), '/tmp/nope-wan22.json'), /Walang Wan 2\.2 workflow/);
});

test('the workflow path follows COMFYUI_WORKFLOW_WAN22', () => withEnv({
  COMFYUI_WORKFLOW_WAN22: '/tmp/custom-wan22.json',
}, () => {
  assert.equal(wan22WorkflowPath(), '/tmp/custom-wan22.json');
}));

// ---------------------------------------------------------------------------
// Status: the pre-flight check
// ---------------------------------------------------------------------------

test('status is ok when ComfyUI lists all three Wan 2.2 files', async () => {
  const comfy = await startComfy(ALL_MODELS);
  try {
    const status = await checkWan22Status({ baseUrl: comfy.base });
    assert.equal(status.ok, true, status.note);
    assert.equal(status.reachable, true);
    assert.equal(status.workflowPresent, true);
    assert.deepEqual(status.missingModels, []);
    assert.match(status.note, /Wan 2\.2 handa/);
  } finally {
    await comfy.close();
  }
});

test('status names the model ComfyUI cannot see', async () => {
  const comfy = await startComfy({ ...ALL_MODELS, vae: ['some_other_vae.safetensors'] });
  try {
    const status = await checkWan22Status({ baseUrl: comfy.base });
    assert.equal(status.ok, false);
    assert.deepEqual(status.missingModels, ['wan2.2_vae.safetensors']);
    assert.match(status.note, /wan2\.2_vae\.safetensors/);
  } finally {
    await comfy.close();
  }
});

test('status reports an unreachable ComfyUI with the URL, not a throw', async () => {
  const status = await checkWan22Status({ baseUrl: 'http://127.0.0.1:1' });
  assert.equal(status.ok, false);
  assert.equal(status.reachable, false);
  assert.match(status.note, /hindi maabot ang ComfyUI sa http:\/\/127\.0\.0\.1:1/);
});

test('status reports an HTTP error from ComfyUI as unreachable', async () => {
  const comfy = await startComfy(ALL_MODELS, { up: false });
  try {
    const status = await checkWan22Status({ baseUrl: comfy.base });
    assert.equal(status.ok, false);
    assert.equal(status.reachable, false);
    assert.match(status.note, /HTTP 503/);
  } finally {
    await comfy.close();
  }
});

test('status reports a missing workflow file', async () => {
  const status = await checkWan22Status({ baseUrl: 'http://127.0.0.1:1', file: '/tmp/absent-wan22.json' });
  assert.equal(status.ok, false);
  assert.equal(status.workflowPresent, false);
  assert.match(status.note, /Walang Wan 2\.2 workflow/);
});

test('comfyLoaderOptions reads the real ComfyUI object_info shape', async () => {
  const comfy = await startComfy(ALL_MODELS);
  try {
    const unets = await comfyLoaderOptions('UNETLoader', 'unet_name', comfy.base);
    assert.deepEqual(unets, ['wan2.2_ti2v_5B_fp16.safetensors']);
  } finally {
    await comfy.close();
  }
});

test('comfyLoaderOptions throws on an unknown node instead of returning empty', async () => {
  const comfy = await startComfy(ALL_MODELS);
  try {
    await assert.rejects(
      () => comfyLoaderOptions('UNETLoader', 'unet_name', `${comfy.base}/missing`),
      /HTTP 404/,
    );
  } finally {
    await comfy.close();
  }
});

test('a base URL with a trailing slash still works', async () => {
  const comfy = await startComfy(ALL_MODELS);
  try {
    const status = await checkWan22Status({ baseUrl: `${comfy.base}/` });
    assert.equal(status.reachable, true);
    assert.equal(status.ok, true);
  } finally {
    await comfy.close();
  }
});
