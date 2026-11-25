import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderVideo, videoRenderReady, preferredRenderEngine, VideoBackendUnavailable } from './videoRenderService.ts';
import {
  setFalClientForTests, normaliseAspect, normaliseResolution, type FalLike,
} from './fal.ts';
import { startMockComfyUI, writeVideoWorkflow, tinyMp4 } from '../testing/comfyuiMock.ts';
import { ffmpegPath } from './render.ts';

const ENV_KEYS = [
  'FAL_KEY', 'WAN_VIDEO_ENDPOINT', 'OPENCUT_ENDPOINT',
  'COMFYUI_URL', 'COMFYUI_VIDEO_WORKFLOW', 'COMFYUI_DISABLE',
  'PREFERRED_RENDER_ENGINE', 'ALLOW_PAID_CLOUD',
  'POLLINATIONS_URL', 'POLLINATIONS_DISABLE', 'MOTION_DISABLE',
  'STRICT_REAL_VIDEO_ONLY',
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
  const workflow = writeVideoWorkflow(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));

  await withEnv({
    PREFERRED_RENDER_ENGINE: 'comfyui',
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

test('cloud-first (PREFERRED_RENDER_ENGINE=fal) skips ComfyUI and goes straight to Wan', async (t) => {
  const clip = await startClipServer(tinyMp4());
  t.after(() => clip.close());
  const { fake, calls } = fakeFal(clip.url);
  setFalClientForTests(fake);
  t.after(() => setFalClientForTests(null));

  // A ComfyUI that is up and configured: with fal preferred it must NOT be used.
  const comfy = await startMockComfyUI();
  t.after(() => comfy.close());
  const workflow = writeVideoWorkflow(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));

  await withEnv({
    PREFERRED_RENDER_ENGINE: 'fal',
    COMFYUI_URL: comfy.url,
    COMFYUI_VIDEO_WORKFLOW: workflow,
    FAL_KEY: 'fal-test-key',
    ALLOW_PAID_CLOUD: '1',
  }, async () => {
    const out = await renderVideo({ prompt: 'isang bagyo', aspectRatio: '16:9', resolution: '720p' });
    assert.equal(out.engine, 'wan', 'fal is primary, so Wan renders');
    assert.equal(calls.length, 1, 'exactly one Wan call, no ComfyUI ping');
    assert.equal(calls[0].endpoint, 'fal-ai/wan/v2.2-a14b/text-to-video');
    assert.equal(comfy.requests(), 0, 'ComfyUI must not be pinged when fal is preferred');
  });
});

test('the paid Wan path is blocked unless the deployment opts in', async (t) => {
  const clip = await startClipServer(tinyMp4());
  t.after(() => clip.close());
  const { fake, calls } = fakeFal(clip.url);
  setFalClientForTests(fake);
  t.after(() => setFalClientForTests(null));

  // FAL_KEY is set, but ALLOW_PAID_CLOUD is not: the no-cost policy wins and
  // the call fails honestly instead of spending. The free engines are switched
  // off too, so the only engine left would be the paid Wan path.
  await withEnv({
    COMFYUI_DISABLE: '1', POLLINATIONS_DISABLE: '1', MOTION_DISABLE: '1',
    FAL_KEY: 'fal-test-key',
  }, async () => {
    assert.equal(await videoRenderReady(), false, 'paid cloud is not ready without the opt-in');
    await assert.rejects(
      () => renderVideo({ prompt: 'isang bagyo' }),
      (err: any) => err instanceof VideoBackendUnavailable && /ALLOW_PAID_CLOUD/.test(err.message),
    );
    assert.equal(calls.length, 0, 'Wan must never be called without the opt-in');
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
    // The free engines come before Wan in the default chain, so switch them off
    // to prove Wan is reached as the last-resort fallback.
    POLLINATIONS_DISABLE: '1',
    MOTION_DISABLE: '1',
    FAL_KEY: 'fal-test-key',
    WAN_VIDEO_ENDPOINT: 'fal-ai/wan/v2.2-a14b/text-to-video',
    ALLOW_PAID_CLOUD: '1',
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

test('no backend at all fails with AI_UNAVAILABLE, never a placeholder', async () => {
  setFalClientForTests(null);
  // Free-first: with the default chain the free motion engine would catch the
  // job, so disable every backend to prove the no-backend path is honest. The
  // strict guard is opted out here so this covers the plain AI_UNAVAILABLE code;
  // the strict code is asserted in its own test below.
  await withEnv({
    COMFYUI_DISABLE: '1', POLLINATIONS_DISABLE: '1', MOTION_DISABLE: '1',
    STRICT_REAL_VIDEO_ONLY: 'false',
  }, async () => {
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
    // These exercise the cloud path (Wan + OpenCut), so pin the engine to fal.
    PREFERRED_RENDER_ENGINE: 'fal',
    COMFYUI_DISABLE: '1',
    FAL_KEY: 'fal-test-key',
    OPENCUT_ENDPOINT: 'fal-ai/opencut',
    ALLOW_PAID_CLOUD: '1',
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
    // These exercise the cloud path (Wan + OpenCut), so pin the engine to fal.
    PREFERRED_RENDER_ENGINE: 'fal',
    COMFYUI_DISABLE: '1',
    FAL_KEY: 'fal-test-key',
    OPENCUT_ENDPOINT: 'fal-ai/opencut',
    ALLOW_PAID_CLOUD: '1',
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

  await withEnv({
    PREFERRED_RENDER_ENGINE: 'fal', COMFYUI_DISABLE: '1',
    FAL_KEY: 'fal-test-key', ALLOW_PAID_CLOUD: '1',
  }, async () => {
    const out = await renderVideo({ prompt: 'isang eksena', editInstructions: 'i-grade' });
    assert.equal(out.editor, undefined);
    assert.match(out.editNote || '', /OPENCUT_ENDPOINT is not set/);
    assert.equal(calls.length, 1, 'only Wan ran; no editing endpoint was called');
  });
});

test('the editing pass is skipped by the no-cost policy even with an endpoint set', async (t) => {
  const clip = await startClipServer(tinyMp4());
  t.after(() => clip.close());
  const { fake, calls } = fakeFal(clip.url);
  setFalClientForTests(fake);
  t.after(() => setFalClientForTests(null));

  // The clip is already rendered locally; only the paid edit is blocked.
  const comfy = await startMockComfyUI();
  t.after(() => comfy.close());
  await withEnv({
    PREFERRED_RENDER_ENGINE: 'comfyui',
    COMFYUI_URL: comfy.url,
    COMFYUI_VIDEO_WORKFLOW: writeVideoWorkflow(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'))),
    FAL_KEY: 'fal-test-key',
    OPENCUT_ENDPOINT: 'fal-ai/opencut',
  }, async () => {
    const out = await renderVideo({ prompt: 'isang eksena', editInstructions: 'i-grade' });
    assert.equal(out.editor, undefined, 'no paid edit without the opt-in');
    assert.match(out.editNote || '', /ALLOW_PAID_CLOUD/);
    assert.equal(calls.length, 0, 'OpenCut must not be called without the opt-in');
  });
});

/** A local stand-in for the free Pollinations image service (answers a JPEG). */
function startFakePollinations() {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'image/jpeg');
    res.end(fakeJpeg());
  });
  return new Promise<{ url: string; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) });
    });
  });
}

let fakeJpegCache: Buffer | null = null;
function fakeJpeg(): Buffer {
  if (fakeJpegCache) return fakeJpegCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pol-'));
  const out = path.join(dir, 'x.jpg');
  execFileSync(ffmpegPath(), [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=512x512:rate=1', '-frames:v', '1', '-q:v', '2', out,
  ]);
  fakeJpegCache = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return fakeJpegCache;
}

test('the free motion engine renders a real MP4 from a free image, no key and no cloud', async (t) => {
  const poll = await startFakePollinations();
  t.after(() => poll.close());
  await withEnv({
    PREFERRED_RENDER_ENGINE: 'motion',
    COMFYUI_DISABLE: '1',
    POLLINATIONS_URL: poll.url,
  }, async () => {
    assert.equal(await videoRenderReady(), true, 'the free engine makes the pipeline ready');
    const out = await renderVideo({ prompt: 'isang eksena sa dagat', seconds: 2 });
    assert.equal(out.engine, 'motion', 'the no-cost engine produced the clip');
    assert.ok(out.data.length > 1000, 'a real clip came back');
    assert.equal(out.data.subarray(4, 8).toString('ascii'), 'ftyp', 'it is a genuine MP4');
  });
});

test('the free motion engine refuses honestly when no image backend exists', async () => {
  await withEnv({
    PREFERRED_RENDER_ENGINE: 'motion',
    COMFYUI_DISABLE: '1',
    POLLINATIONS_DISABLE: '1',
  }, async () => {
    assert.equal(await videoRenderReady(), false);
    await assert.rejects(
      () => renderVideo({ prompt: 'wala' }),
      (err: any) => err instanceof VideoBackendUnavailable && err.code === 'AI_UNAVAILABLE',
    );
  });
});

test('with ComfyUI OFF, the free motion engine catches the job (real failover)', async (t) => {
  const poll = await startFakePollinations();
  t.after(() => poll.close());
  await withEnv({
    PREFERRED_RENDER_ENGINE: 'comfyui',
    COMFYUI_DISABLE: '1',
    POLLINATIONS_URL: poll.url,
    // This test is about the free failover, so it opts out of the strict guard.
    STRICT_REAL_VIDEO_ONLY: 'false',
  }, async () => {
    assert.equal(await videoRenderReady(), true, 'a free engine is still ready');
    const out = await renderVideo({ prompt: 'isang eksena sa gubat', seconds: 2 });
    assert.equal(out.engine, 'motion', 'the free engine caught the job ComfyUI dropped');
    assert.equal(out.data.subarray(4, 8).toString('ascii'), 'ftyp', 'genuine MP4');
  });
});

test('ComfyUI on and answering wins over the free engine (no silent downgrade)', async (t) => {
  const clip = await startClipServer(tinyMp4());
  t.after(() => clip.close());
  const comfy = await startMockComfyUI();
  t.after(() => comfy.close());
  const workflow = writeVideoWorkflow(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));
  const poll = await startFakePollinations();
  t.after(() => poll.close());

  await withEnv({
    PREFERRED_RENDER_ENGINE: 'comfyui',
    COMFYUI_URL: comfy.url,
    COMFYUI_VIDEO_WORKFLOW: workflow,
    POLLINATIONS_URL: poll.url,
  }, async () => {
    const out = await renderVideo({ prompt: 'isang eksena' });
    assert.equal(out.engine, 'comfyui', 'ComfyUI answers, so it is used');
  });
});

test('an unset engine defaults to the free chain, never paid cloud', async () => {
  await withEnv({ COMFYUI_DISABLE: '1', POLLINATIONS_DISABLE: '1' }, async () => {
    assert.equal(preferredRenderEngine(), 'comfyui',
      'with nothing set the pipeline is free-first; only an explicit fal pays');
  });
});

test('strict mode refuses with COMFYUI_WAN22_UNAVAILABLE and never a fallback clip', async (t) => {
  setFalClientForTests(null);
  // A ComfyUI that answers /system_stats but has none of the Wan 2.2 weights is
  // the exact scenario the guard was built for: offline-looking, yet reachable.
  const comfy = await startMockComfyUI({ models: [] });
  t.after(() => comfy.close());
  const poll = await startFakePollinations();
  t.after(() => poll.close());

  await withEnv({
    PREFERRED_RENDER_ENGINE: 'comfyui',
    COMFYUI_URL: comfy.url,
    COMFYUI_VIDEO_WORKFLOW: writeVideoWorkflow(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'))),
    POLLINATIONS_URL: poll.url,
    STRICT_REAL_VIDEO_ONLY: 'true',
  }, async () => {
    await assert.rejects(
      () => renderVideo({ prompt: 'isang eksena' }),
      (err: any) => {
        assert.equal(err.code, 'COMFYUI_WAN22_UNAVAILABLE');
        assert.equal(err.name, 'ComfyWan22Unavailable');
        assert.ok(Array.isArray(err.missing), 'the missing files are listed');
        // The message must name the exact dependency, not just "unavailable".
        assert.match(err.message, /wan2\.2_ti2v_5B_fp16\.safetensors/);
        return true;
      },
    );
  });
});

test('strict mode is the default for the comfyui engine, and off elsewhere', async () => {
  await withEnv({ PREFERRED_RENDER_ENGINE: 'comfyui' }, async () => {
    const { strictRealVideoOnly } = await import('./strictVideo.ts');
    assert.equal(strictRealVideoOnly('comfyui'), true, 'comfyui promises a local GPU render');
    assert.equal(strictRealVideoOnly('motion'), false, 'motion is the free engine itself');
    assert.equal(strictRealVideoOnly('fal'), false, 'the paid cloud path is a real render');
  });
});

test('STRICT_REAL_VIDEO_ONLY=false still allows the free motion engine', async (t) => {
  const poll = await startFakePollinations();
  t.after(() => poll.close());
  await withEnv({
    PREFERRED_RENDER_ENGINE: 'comfyui',
    COMFYUI_DISABLE: '1',
    POLLINATIONS_URL: poll.url,
    STRICT_REAL_VIDEO_ONLY: 'false',
  }, async () => {
    const out = await renderVideo({ prompt: 'isang eksena sa gubat', seconds: 2 });
    assert.equal(out.engine, 'motion', 'the operator opted out, so the fallback runs');
  });
});

test('a MASTER job is refused before the free motion engine can touch it', async (t) => {
  const poll = await startFakePollinations();
  t.after(() => poll.close());
  await withEnv({
    PREFERRED_RENDER_ENGINE: 'comfyui',
    COMFYUI_DISABLE: '1',
    POLLINATIONS_URL: poll.url,
    STRICT_REAL_VIDEO_ONLY: 'false',
    FAL_KEY: '',
  }, async () => {
    // ComfyUI is off and the operator disabled strict mode, so the free engine
    // is reachable. A CANARY job takes it; a MASTER job must not.
    const canary = await renderVideo({ prompt: 'gubat', seconds: 2, qualityTier: 'CANARY' });
    assert.equal(canary.engine, 'motion');
    assert.equal(canary.mediaClass, 'STILL_MOTION');

    await assert.rejects(
      () => renderVideo({ prompt: 'gubat', seconds: 2, qualityTier: 'MASTER' }),
      (error: any) => {
        assert.equal(error.code, 'REQUIRED_MASTER_BACKEND_UNAVAILABLE');
        assert.equal(error.name, 'MasterBackendBlocked');
        assert.match(error.message, /STILL_MOTION/);
        // It must never hand back a clip alongside the refusal.
        assert.equal(error.data, undefined);
        return true;
      },
    );
  });
});

test('a MASTER job reports what the bytes are, so the caller can check it', async (t) => {
  const comfy = await startMockComfyUI();
  t.after(() => comfy.close());
  const workflow = writeVideoWorkflow(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));
  await withEnv({
    PREFERRED_RENDER_ENGINE: 'comfyui',
    COMFYUI_URL: comfy.url,
    COMFYUI_VIDEO_WORKFLOW: workflow,
    STRICT_REAL_VIDEO_ONLY: 'true',
  }, async () => {
    const out = await renderVideo({ prompt: 'isang render', qualityTier: 'MASTER' });
    assert.equal(out.engine, 'comfyui');
    assert.equal(out.mediaClass, 'SYNTHETIC_MOTION');
    assert.equal(out.qualityTier, 'MASTER');
  });
});

test('PREFERRED_RENDER_ENGINE=motion is refused outright for MASTER', async () => {
  await withEnv({
    PREFERRED_RENDER_ENGINE: 'motion',
    STRICT_REAL_VIDEO_ONLY: 'false',
  }, async () => {
    await assert.rejects(
      () => renderVideo({ prompt: 'x', seconds: 1, qualityTier: 'MASTER' }),
      (error: any) => {
        assert.equal(error.code, 'REQUIRED_MASTER_BACKEND_UNAVAILABLE');
        assert.match(error.message, /PREFERRED_RENDER_ENGINE=motion/);
        return true;
      },
    );
  });
});

test('PREFERRED_RENDER_ENGINE=stock is refused for MASTER, since stock is not this render', async () => {
  await withEnv({
    PREFERRED_RENDER_ENGINE: 'stock',
    PEXELS_API_KEY: 'test-key',
    STRICT_REAL_VIDEO_ONLY: 'false',
  }, async () => {
    await assert.rejects(
      () => renderVideo({ prompt: 'x', seconds: 1, qualityTier: 'MASTER' }),
      (error: any) => {
        assert.equal(error.code, 'REQUIRED_MASTER_BACKEND_UNAVAILABLE');
        assert.match(error.message, /stock/i);
        return true;
      },
    );
  });
});
