/**
 * Test-only stand-in for the ComfyUI HTTP API.
 *
 * It answers the same endpoints the real server does (`/system_stats`,
 * `/prompt`, `/history/<id>`, `/view`) and hands back a genuinely valid MP4,
 * so the orchestration code runs for real instead of being swapped out for a
 * fabricated buffer. Nothing here is imported by the app itself.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ffmpegPath } from '../direk/render.ts';

let cached: Buffer | null = null;

/** A real one-second 320x240 clip with an audio track, built once per process. */
export function tinyMp4(): Buffer {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfymock-'));
  const out = path.join(dir, 'clip.mp4');
  execFileSync(ffmpegPath(), [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-t', '1', out,
  ]);
  cached = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return cached;
}

/**
 * Write an AnimateDiff/SVD-style workflow template with the placeholders the
 * app fills. The mock never reads it; the app only needs it to exist.
 */
export function writeVideoWorkflow(dir: string): string {
  const file = path.join(dir, 'video-workflow.json');
  fs.writeFileSync(file, JSON.stringify({
    '3': { class_type: 'KSampler', inputs: { seed: '__SEED__', positive: ['6', 0], negative: ['7', 0] } },
    '5': { class_type: 'EmptyLatentVideo', inputs: { width: '__WIDTH__', height: '__HEIGHT__', frames: '__FRAMES__' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__', ckpt_name: '__CHECKPOINT__' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '__NEGATIVE__' } },
  }, null, 2));
  return file;
}

/**
 * The model lists ComfyUI reports on `/object_info`, in its own combo shape:
 * a combo is `[[...names], {...}]`, so the first entry is the list.
 */
export const WAN22_OBJECT_INFO = {
  UNETLoader: { input: { unet_name: [['wan2.2_ti2v_5B_fp16.safetensors', 'sd_xl_base_1.0.safetensors'], {}] } },
  CLIPLoader: { input: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors'], {}] } },
  VAELoader: { input: { vae_name: [['wan2.2_vae.safetensors'], {}] } },
};

/**
 * A minimal ComfyUI server: real endpoints, real MP4 bytes.
 *
 * `models` controls what `/object_info` advertises. An empty list stands for a
 * ComfyUI that is running but has none of the Wan 2.2 weights installed.
 */
export function startMockComfyUI(
  opts: { mp4?: Buffer; models?: string[]; objectInfo?: unknown } = {},
) {
  const mp4 = opts.mp4 ?? tinyMp4();
  const models = opts.models;
  const objectInfo = opts.objectInfo ?? (
    models === undefined
      ? WAN22_OBJECT_INFO
      : {
        UNETLoader: { input: { unet_name: [models, {}] } },
        CLIPLoader: { input: { clip_name: [models, {}] } },
        VAELoader: { input: { vae_name: [models, {}] } },
      }
  );
  let counter = 0;
  let requests = 0;
  let renders = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    const url = req.url || '';
    if (url.startsWith('/system_stats')) {
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
      return;
    }
    if (url.startsWith('/object_info')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(objectInfo));
      return;
    }
    if (url.startsWith('/prompt') && req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        // A real ComfyUI rejects a graph that references a checkpoint it does
        // not have, and puts the node-level reason in the body. An empty model
        // list therefore fails the queue, exactly as a missing weight would.
        if (Array.isArray(models) && models.length === 0) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: {
              type: 'prompt_outputs_failed_validation',
              message: 'Prompt outputs failed validation',
              details: 'Value not in list: unet_name: wan2.2_ti2v_5B_fp16.safetensors not in []',
            },
            node_errors: {},
          }));
          return;
        }
        counter += 1;
        renders += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ prompt_id: `prompt-${counter}` }));
      });
      return;
    }
    if (url.startsWith('/history/')) {
      const id = url.slice('/history/'.length);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        [id]: { outputs: { '9': { gifs: [{ filename: 'scene.mp4', subfolder: '', type: 'output' }] } } },
      }));
      return;
    }
    if (url.startsWith('/view')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.end(mp4);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise<{ url: string; close: () => Promise<void>; requests: () => number; renders: () => number }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
        requests: () => requests,
        // Queued graphs only: the proof that a shot was rendered, not just polled.
        renders: () => renders,
      });
    });
  });
}

/** Run `fn` with ComfyUI pointed at the mock, then restore the environment. */
export async function withMockComfyUI<T>(
  mock: { url: string },
  workflow: string,
  fn: () => Promise<T>,
): Promise<T> {
  const keys = ['COMFYUI_URL', 'COMFYUI_VIDEO_WORKFLOW', 'COMFYUI_DISABLE'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  process.env.COMFYUI_URL = mock.url;
  process.env.COMFYUI_VIDEO_WORKFLOW = workflow;
  delete process.env.COMFYUI_DISABLE;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
