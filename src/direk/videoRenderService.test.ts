import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderVideo, videoRenderReady, videoRenderDetail, VideoBackendUnavailable,
} from './videoRenderService.ts';
import { startMockComfyUI, writeVideoWorkflow } from '../testing/comfyuiMock.ts';

const ENV_KEYS = [
  'COMFYUI_URL', 'COMFYUI_VIDEO_WORKFLOW', 'COMFYUI_DISABLE',
  'OPENCUT_ENDPOINT', 'ALLOW_PAID_CLOUD', 'FAL_KEY',
  'PREFERRED_RENDER_ENGINE', 'POLLINATIONS_URL', 'MOTION_DISABLE',
];

/** Run `fn` with a clean slate for the video-related environment. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function workflowFile(): string {
  return writeVideoWorkflow(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));
}

test('a real ComfyUI render is used, and the engine is always "comfyui"', async (t) => {
  const comfy = await startMockComfyUI();
  t.after(() => comfy.close());
  await withEnv({
    COMFYUI_URL: comfy.url,
    COMFYUI_VIDEO_WORKFLOW: workflowFile(),
  }, async () => {
    assert.equal(await videoRenderReady(), true, 'the ComfyUI backend is ready');
    const out = await renderVideo({ prompt: 'isang eksena', negative: 'blurry' });
    assert.equal(out.engine, 'comfyui', 'the clip is credited to ComfyUI');
    assert.ok(out.data.length > 1000, 'a real clip came back');
    assert.ok(comfy.requests() > 0, 'ComfyUI was actually called');
  });
});

test('no slideshow fallback: with ComfyUI off the render fails with AI_UNAVAILABLE', async () => {
  await withEnv({ COMFYUI_DISABLE: '1' }, async () => {
    assert.equal(await videoRenderReady(), false, 'no backend is ready');
    await assert.rejects(
      () => renderVideo({ prompt: 'wala' }),
      (err: any) => err instanceof VideoBackendUnavailable && err.code === 'AI_UNAVAILABLE',
    );
  });
});

test('no slideshow fallback: with no workflow the render fails, naming the cause', async () => {
  await withEnv({ COMFYUI_VIDEO_WORKFLOW: undefined }, async () => {
    assert.equal(await videoRenderReady(), false);
    assert.match(await videoRenderDetail(), /COMFYUI_VIDEO_WORKFLOW/);
    await assert.rejects(
      () => renderVideo({ prompt: 'wala' }),
      (err: any) => err instanceof VideoBackendUnavailable && err.code === 'AI_UNAVAILABLE',
    );
  });
});

test('a missing workflow file fails honestly instead of falling back', async () => {
  await withEnv({
    COMFYUI_VIDEO_WORKFLOW: '/no/such/video-workflow.json',
  }, async () => {
    assert.equal(await videoRenderReady(), false);
    assert.match(await videoRenderDetail(), /walang workflow file/i);
    await assert.rejects(
      () => renderVideo({ prompt: 'wala' }),
      (err: any) => err instanceof VideoBackendUnavailable && err.code === 'AI_UNAVAILABLE',
    );
  });
});

test('an unfilled placeholder fails instead of sending a broken graph', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-bad-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({
    '1': { class_type: 'KSampler', inputs: { seed: '__SEED__', unknown: '__NOPE__' } },
  }));
  await withEnv({ COMFYUI_VIDEO_WORKFLOW: file }, async () => {
    assert.equal(await videoRenderReady(), false);
    assert.match(await videoRenderDetail(), /__NOPE__/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreachable ComfyUI fails with AI_UNAVAILABLE, never a fake clip', async () => {
  await withEnv({
    COMFYUI_URL: 'http://127.0.0.1:9',
    COMFYUI_VIDEO_WORKFLOW: workflowFile(),
  }, async () => {
    assert.equal(await videoRenderReady(), false);
    await assert.rejects(
      () => renderVideo({ prompt: 'wala' }),
      (err: any) => err instanceof VideoBackendUnavailable && err.code === 'AI_UNAVAILABLE',
    );
  });
});

test('PREFERRED_RENDER_ENGINE no longer selects a free engine: it is ignored', async (t) => {
  // The old free motion engine used to catch the job here. Video is
  // ComfyUI-only now, so `motion` cannot make a clip; with ComfyUI off the
  // render must fail rather than fall back to a slideshow.
  const comfy = await startMockComfyUI();
  t.after(() => comfy.close());
  await withEnv({
    PREFERRED_RENDER_ENGINE: 'motion',
    COMFYUI_DISABLE: '1',
  }, async () => {
    assert.equal(await videoRenderReady(), false, 'no free engine can answer');
    await assert.rejects(
      () => renderVideo({ prompt: 'isang eksena sa dagat' }),
      (err: any) => err instanceof VideoBackendUnavailable && err.code === 'AI_UNAVAILABLE',
    );
  });
});

test('the OpenCut editing pass is skipped by the no-cost policy, not faked', async (t) => {
  const comfy = await startMockComfyUI();
  t.after(() => comfy.close());
  await withEnv({
    COMFYUI_URL: comfy.url,
    COMFYUI_VIDEO_WORKFLOW: workflowFile(),
    OPENCUT_ENDPOINT: 'fal-ai/opencut',
    FAL_KEY: 'fal-test-key',
  }, async () => {
    const out = await renderVideo({ prompt: 'isang eksena', editInstructions: 'i-grade' });
    assert.equal(out.engine, 'comfyui');
    assert.equal(out.editor, undefined, 'no paid edit without the opt-in');
    assert.match(out.editNote || '', /ALLOW_PAID_CLOUD/);
  });
});
