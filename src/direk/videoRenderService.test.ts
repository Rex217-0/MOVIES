import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { renderVideo, videoRenderReady, VideoBackendUnavailable } from './videoRenderService.ts';
import {
  setFalClientForTests, normaliseAspect, normaliseResolution, type FalLike,
} from './fal.ts';
import { startMockComfyUI, writeVideoWorkflow, tinyMp4 } from '../testing/comfyuiMock.ts';

const ENV_KEYS = [
  'FAL_KEY', 'WAN_VIDEO_ENDPOINT', 'OPENCUT_ENDPOINT',
  'COMFYUI_URL', 'COMFYUI_VIDEO_WORKFLOW', 'COMFYUI_DISABLE',
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

/** A local HTTP server that serves one real MP4 at any path. */
function startClipServer(bytes: Buffer) {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'video/mp4');
    res.end(bytes);
  });
  return new Promise<{ url: string; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/out.mp4`, close: () => new Promise<void>(r => server.close(() => r())) });
    });
  });
}

/** A fake fal client: records every call, returns a URL to a real clip. */
function fakeFal(clipUrl: string) {
  const calls: { endpoint: string; input: Record<string, unknown> }[] = [];
  const uploads: Blob[] = [];
  const fake: FalLike = {
    config: () => {},
    subscribe: async (endpoint, options) => {
      calls.push({ endpoint, input: options.input });
      if (endpoint.startsWith('fal-ai/opencut')) return { data: { video: { url: clipUrl } } };
      return { data: { video: { url: clipUrl } } };
    },
    storage: { upload: async (file: Blob) => { uploads.push(file); return 'https://fal.media/uploaded.mp4'; } },
  };
  return { fake, calls, uploads };
}

test('normaliseAspect and normaliseResolution keep only the values Wan 2.2 accepts', () => {
  assert.equal(normaliseAspect('9:16'), '9:16');
  assert.equal(normaliseAspect('1:1'), '1:1');
  assert.equal(normaliseAspect('4:3'), '16:9');
  assert.equal(normaliseAspect(undefined), '16:9');
  assert.equal(normaliseResolution('480p'), '480p');
  assert.equal(normaliseResolution('580p'), '580p');
  assert.equal(normaliseResolution('1080p'), '720p');
  assert.equal(normaliseResolution(undefined), '720p');
});

test('the local ComfyUI is used first and Wan is never called', async (t) => {
  const clip = await startClipServer(tinyMp4());
  t.after(() => clip.close());
  const { fake, calls } = fakeFal(clip.url);
  setFalClientForTests(fake);
  t.after(() => setFalClientForTests(null));

  const comfy = await startMockComfyUI();
  t.after(() => comfy.close());
  const workflow = writeVideoWorkflow(await import('node:fs').then(fs => fs.mkdtempSync('/tmp/wf-')));

  await withEnv({
    COMFYUI_URL: comfy.url,
    COMFYUI_VIDEO_WORKFLOW: workflow,
    FAL_KEY: 'fal-test-key',
  }, async () => {
    const out = await renderVideo({ prompt: 'isang eksena', negative: 'blurry' });
    assert.equal(out.engine, 'comfyui');
    assert.ok(out.data.length > 1000, 'a real clip came back');
    assert.equal(calls.length, 0, 'Wan must not run when ComfyUI answers');
  });
});

test('Wan 2.2 on fal.ai is the fallback when ComfyUI cannot render', async (t) => {
  const clip = await startClipServer(tinyMp4());
  t.after(() => clip.close());
  const { fake, calls } = fakeFal(clip.url);
  setFalClientForTests(fake);
  t.after(() => setFalClientForTests(null));

  await withEnv({
    COMFYUI_DISABLE: '1',
    FAL_KEY: 'fal-test-key',
    WAN_VIDEO_ENDPOINT: 'fal-ai/wan/v2.2-a14b/text-to-video',
  }, async () => {
    assert.equal(await videoRenderReady(), true, 'Wan makes the pipeline ready');
    const out = await renderVideo({ prompt: 'isang bagyo', aspectRatio: '16:9', resolution: '720p' });
    assert.equal(out.engine, 'wan');
    assert.ok(out.data.length > 1000, 'the Wan clip was downloaded');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, 'fal-ai/wan/v2.2-a14b/text-to-video');
    assert.equal(calls[0].input.prompt, 'isang bagyo');
    assert.equal(calls[0].input.aspect_ratio, '16:9');
    assert.equal(calls[0].input.resolution, '720p');
  });
});

test('no ComfyUI and no FAL_KEY fails with AI_UNAVAILABLE, never a placeholder', async () => {
  setFalClientForTests(null);
  await withEnv({ COMFYUI_DISABLE: '1' }, async () => {
    assert.equal(await videoRenderReady(), false);
    await assert.rejects(
      () => renderVideo({ prompt: 'wala' }),
      (err: any) => err instanceof VideoBackendUnavailable && err.code === 'AI_UNAVAILABLE',
    );
  });
});

test('OpenCut edits the clip when configured, and the edited bytes are kept', async (t) => {
  const clip = await startClipServer(tinyMp4());
  t.after(() => clip.close());
  const { fake, calls, uploads } = fakeFal(clip.url);
  setFalClientForTests(fake);
  t.after(() => setFalClientForTests(null));

  await withEnv({
    COMFYUI_DISABLE: '1',
    FAL_KEY: 'fal-test-key',
    OPENCUT_ENDPOINT: 'fal-ai/opencut',
  }, async () => {
    const out = await renderVideo({ prompt: 'isang eksena', editInstructions: 'putulin sa 4s' });
    assert.equal(out.engine, 'wan');
    assert.equal(out.editor, 'opencut');
    assert.equal(uploads.length, 1, 'the raw clip was uploaded for editing');
    assert.deepEqual(
      calls.map(c => c.endpoint),
      ['fal-ai/wan/v2.2-a14b/text-to-video', 'fal-ai/opencut'],
    );
    assert.equal(calls[1].input.prompt, 'putulin sa 4s');
    assert.equal(calls[1].input.video_url, 'https://fal.media/uploaded.mp4');
  });
});

test('a failed OpenCut pass keeps the raw clip instead of throwing it away', async (t) => {
  const clip = await startClipServer(tinyMp4());
  t.after(() => clip.close());
  const calls: string[] = [];
  const fake: FalLike = {
    config: () => {},
    subscribe: async endpoint => {
      calls.push(endpoint);
      if (endpoint === 'fal-ai/opencut') throw new Error('opencut 500');
      return { data: { video: { url: clip.url } } };
    },
    storage: { upload: async () => 'https://fal.media/uploaded.mp4' },
  };
  setFalClientForTests(fake);
  t.after(() => setFalClientForTests(null));

  await withEnv({
    COMFYUI_DISABLE: '1',
    FAL_KEY: 'fal-test-key',
    OPENCUT_ENDPOINT: 'fal-ai/opencut',
  }, async () => {
    const out = await renderVideo({ prompt: 'isang eksena', editInstructions: 'i-grade' });
    assert.equal(out.engine, 'wan');
    assert.equal(out.editor, undefined, 'no editor when OpenCut fails');
    assert.match(out.editNote || '', /OpenCut editing failed/);
    assert.ok(out.data.length > 1000, 'the raw clip survived');
    assert.deepEqual(calls, ['fal-ai/wan/v2.2-a14b/text-to-video', 'fal-ai/opencut']);
  });
});

test('without an OpenCut endpoint the editing pass is skipped, not faked', async (t) => {
  const clip = await startClipServer(tinyMp4());
  t.after(() => clip.close());
  const { fake, calls } = fakeFal(clip.url);
  setFalClientForTests(fake);
  t.after(() => setFalClientForTests(null));

  await withEnv({ COMFYUI_DISABLE: '1', FAL_KEY: 'fal-test-key' }, async () => {
    const out = await renderVideo({ prompt: 'isang eksena', editInstructions: 'i-grade' });
    assert.equal(out.editor, undefined);
    assert.match(out.editNote || '', /OPENCUT_ENDPOINT is not set/);
    assert.equal(calls.length, 1, 'only Wan ran; no editing endpoint was called');
  });
});
