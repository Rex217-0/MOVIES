// A GPU worker for the movie mesh.
//
// Run this on any machine that has a GPU (or just CPU) and wants to contribute
// to the factory. It registers with the coordinator, keeps a heartbeat, and
// serves one job endpoint. It is deliberately small and dependency-free: it
// talks to ComfyUI over HTTP and runs ffmpeg, both of which the machine already
// has if it can render.
//
// Usage:
//   COORDINATOR_URL=https://movies.example.com \
//   WORKER_ID=gpu-rig-1 \
//   WORKER_TOKEN=<a secret the coordinator must present> \
//   COMFYUI_URL=http://127.0.0.1:8188 \
//   node scripts/worker.mjs
//
// Honesty rules, the same as the app:
//   - Never answer a job with a stub. If the render fails, the job fails.
//   - Report the real duration and bytes; the coordinator verifies them.
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * The ffmpeg binary. Prefer the one bundled with the app (the same static build
 * the coordinator uses), then PATH. Without this a worker on a machine that has
 * no system ffmpeg reports `seconds: 0`, and the coordinator's verification
 * rejects a real render as if it were a stub.
 */
const FFMPEG_BIN = (() => {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require('@ffmpeg-installer/ffmpeg').path;
  } catch {
    return 'ffmpeg';
  }
})();

const COORDINATOR_URL = (process.env.COORDINATOR_URL || '').replace(/\/+$/, '');
const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const COMFYUI_URL = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const ENGINES = (process.env.WORKER_ENGINES || 'comfyui,ffmpeg').split(',').map(s => s.trim()).filter(Boolean);
const GPU = process.env.WORKER_GPU || '';
// 'gpu', 'cpu' or 'phone' (Blocker G). A phone is a low-tier CPU contributor
// only; the coordinator will never place a heavy GPU job on it.
const ROLE = process.env.WORKER_ROLE || (GPU ? 'gpu' : 'cpu');
const VRAM_GB = Number(process.env.WORKER_VRAM_GB || '0') || undefined;
const PORT = Number(process.env.WORKER_PORT || '8090');
const HOST = process.env.WORKER_HOST || '0.0.0.0';
const MAX_CONCURRENT = Number(process.env.WORKER_MAX_CONCURRENT || '1');
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS || '30000');

/** What this worker tells the coordinator it can do. */
const capabilities = { gpu: GPU || undefined, vram_gb: VRAM_GB, engines: ENGINES };

async function register() {
  if (!COORDINATOR_URL) {
    console.error('COORDINATOR_URL is required (e.g. https://movies.example.com).');
    process.exit(1);
  }
  const res = await fetch(`${COORDINATOR_URL}/api/direk/workers/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: WORKER_ID,
      label: `${WORKER_ID} (${GPU || 'cpu'})`,
      url: process.env.WORKER_PUBLIC_URL || `http://${localAddress()}:${PORT}`,
      token: WORKER_TOKEN || undefined,
      capabilities,
      role: ROLE,
      maxConcurrent: MAX_CONCURRENT,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text().catch(() => '')}`);
  console.log(`[worker] registered as ${WORKER_ID}`);
}

function localAddress() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

async function heartbeat() {
  try {
    await fetch(`${COORDINATOR_URL}/api/direk/workers/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: WORKER_ID }),
    });
  } catch (error) {
    console.error(`[worker] heartbeat failed: ${error?.message || error}`);
  }
}

/** Ask ComfyUI to render a video workflow and return the file bytes. */
async function runComfyUiVideo(payload) {
  const workflow = payload.workflow;
  if (!workflow) throw new Error('comfyui job needs a "workflow" payload');
  const queued = await fetch(`${COMFYUI_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: WORKER_ID }),
  });
  if (!queued.ok) throw new Error(`ComfyUI /prompt ${queued.status}`);
  const { prompt_id: promptId } = await queued.json();
  if (!promptId) throw new Error('ComfyUI did not return a prompt_id');

  // Poll history until the render appears.
  for (let i = 0; i < 600; i++) {
    const hist = await fetch(`${COMFYUI_URL}/history/${promptId}`).then(r => r.json());
    const entry = hist?.[promptId];
    if (entry?.outputs) {
      const file = firstOutputFile(entry.outputs);
      if (!file) throw new Error('ComfyUI produced no output file');
      const url = `${COMFYUI_URL}/view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder || '')}&type=${file.type || 'output'}`;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      return { data: buf, filename: file.filename };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('ComfyUI render timed out');
}

function firstOutputFile(outputs) {
  for (const node of Object.values(outputs)) {
    for (const key of ['videos', 'gifs', 'images']) {
      const list = node?.[key];
      if (Array.isArray(list) && list.length) return list[0];
    }
  }
  return null;
}

/** Probe a media file with ffmpeg and return its duration in seconds. */
async function probeSeconds(file) {
  try {
    const { stderr } = await execFileAsync(FFMPEG_BIN, ['-hide_banner', '-i', file], { maxBuffer: 8 * 1024 * 1024 });
    return parseDuration(String(stderr || ''));
  } catch (error) {
    // ffmpeg exits non-zero when there is no output file; the report is on stderr.
    return parseDuration(String(error?.stderr || ''));
  }
}

function parseDuration(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]) : 0;
}

async function handleJob(body) {
  const task = body?.task || body?.engine || '';
  if (task === 'video_render' || body?.engine === 'comfyui') {
    const { data, filename } = await runComfyUiVideo(body.payload || {});
    // Write to a temp file so ffmpeg can report the real duration.
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmp = path.join(os.tmpdir(), `${WORKER_ID}-${Date.now()}-${filename}`);
    fs.writeFileSync(tmp, data);
    const seconds = await probeSeconds(tmp);
    fs.rmSync(tmp, { force: true });
    return {
      ok: true,
      bytes: data.length,
      seconds,
      // The coordinator fetches the bytes back from here and verifies them.
      video_base64: data.toString('base64'),
      note: `${filename} (${data.length} bytes, ${seconds.toFixed(2)}s)`,
    };
  }
  if (task === 'ffmpeg' || body?.engine === 'ffmpeg') {
    throw new Error('ffmpeg jobs are not implemented yet; the coordinator must not assume they are');
  }
  throw new Error(`Unsupported task: ${task || '(none)'}`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: WORKER_ID, engines: ENGINES }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/job') {
    if (WORKER_TOKEN && req.headers.authorization !== `Bearer ${WORKER_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* handled below */ }
      try {
        const result = await handleJob(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        // A failed job fails. Never a stub.
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error?.message || 'job failed' }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

await register().catch((error) => {
  console.error(`[worker] registration failed: ${error?.message || error}`);
});
setInterval(heartbeat, HEARTBEAT_MS);
server.listen(PORT, HOST, () => {
  console.log(`[worker] listening on http://${HOST}:${PORT} · engines: ${ENGINES.join(', ')}`);
});
