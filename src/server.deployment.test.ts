import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath, isPng } from './direk/render.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** A 1x1 PNG, so the tests need no image fixtures on disk. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A real JPEG, encoded once with the bundled ffmpeg. */
let jpegCache: Buffer | null = null;
function jpeg(): Buffer {
  if (jpegCache) return jpegCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-'));
  const out = path.join(dir, 'x.jpg');
  execFileSync(ffmpegPath(), [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=512x512:rate=1',
    '-frames:v', '1', '-q:v', '2', out,
  ]);
  jpegCache = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return jpegCache;
}

function startServer(env: Record<string, string>) {
  const port = 4900 + Math.floor(Math.random() * 500);
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const child = spawn('node', ['server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      GEMINI_API_KEY: '',
      OLLAMA_DISABLE: '1',
      COMFYUI_DISABLE: '1',
      DIREK_ASSETS_DIR: assetsDir,
      DIREK_CONFIG: path.join(repoRoot, '.no-such-config.json'),
      ...env,
    },
    stdio: 'ignore',
  });
  return { child, port, assetsDir };
}

async function waitForServer(port: number) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

/** Serve a stand-in for Pollinations that always answers with a JPEG. */
async function fakePollinations(): Promise<{ url: string; close: () => void }> {
  const server = createServer((_req, res) => {
    // The real free tier answers with a JPEG whatever the URL asks for.
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(jpeg());
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Read the file names out of a ZIP central directory. */
function zipNames(zip: Buffer): string[] {
  const eocd = zip.length - 22;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = zip.readUInt16LE(p + 28);
    names.push(zip.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return names;
}

/** Extract one entry's bytes from a ZIP (stored or deflated). */
function zipEntry(zip: Buffer, wanted: string): Buffer | null {
  const eocd = zip.length - 22;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === wanted) {
      const lNameLen = zip.readUInt16LE(localOffset + 26);
      const lExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return data;
      return inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

test('the Pollinations JPEG is stored as a real PNG inside the LoRA ZIP', async (t) => {
  const poll = await fakePollinations();
  t.after(poll.close);
  const { child, port } = startServer({ APP_AUTH_TOKEN: '', POLLINATIONS_URL: poll.url });
  t.after(() => child.kill());
  await waitForServer(port);

  const brief = { title: 'Ang Huling Tala', genre: 'horror', mood: 'madilim', durationMinutes: 3 };

  const plan = await fetch(`http://127.0.0.1:${port}/api/direk/lora/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(brief),
  });
  const planBody: any = await plan.json();
  assert.equal(planBody.image_backend, 'pollinations', 'the free backend is used with no key');

  const ds = await fetch(`http://127.0.0.1:${port}/api/direk/lora/dataset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(brief),
  });
  assert.equal(ds.status, 200);
  const zip = Buffer.from(await ds.arrayBuffer());
  const pngs = zipNames(zip).filter(n => n.endsWith('.png'));
  assert.ok(pngs.length > 0, 'the ZIP must contain image files');

  // The whole point: every `.png` entry is genuinely a PNG, not a JPEG.
  const first = zipEntry(zip, pngs[0]);
  assert.ok(first && first.length > 8);
  assert.equal(isPng(first!), true, `${pngs[0]} must carry the PNG signature`);
});

test('the Staging Vault lists assets and records an approve / reject decision', async (t) => {
  const { child, port, assetsDir } = startServer({ APP_AUTH_TOKEN: '' });
  t.after(() => child.kill());
  await waitForServer(port);

  // Drop an asset into the store the server reads.
  const png = PNG_1x1;
  const name = 'movie_test.mp4';
  fs.writeFileSync(path.join(assetsDir, name), Buffer.concat([Buffer.from('fake'), png]));
  fs.writeFileSync(path.join(assetsDir, `${name}.asset.json`), JSON.stringify({
    id: 'AST-1', name, ext: 'mp4', mime: 'video/mp4', bytes: png.length,
    kind: 'video', title: 'Test na Pelikula', source: 'test', createdAt: new Date().toISOString(),
  }));

  const list = await fetch(`http://127.0.0.1:${port}/api/direk/assets`);
  const listBody: any = await list.json();
  assert.equal(listBody.assets.length, 1);
  assert.equal(listBody.assets[0].reviewStatus, 'pending', 'an unreviewed asset waits in staging');

  const approve = await fetch(`http://127.0.0.1:${port}/api/direk/assets/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'AST-1', action: 'approve' }),
  });
  assert.equal(approve.status, 200);
  assert.equal((await approve.json() as any).asset.reviewStatus, 'approved');

  const after = await fetch(`http://127.0.0.1:${port}/api/direk/assets`);
  assert.equal((await after.json() as any).assets[0].reviewStatus, 'approved', 'the decision persists');

  const reject = await fetch(`http://127.0.0.1:${port}/api/direk/assets/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, action: 'reject' }),
  });
  assert.equal(reject.status, 200);
  assert.equal((await reject.json() as any).asset.reviewStatus, 'rejected', 'found by name too');
});

test('the review endpoint rejects a bad request and a missing asset', async (t) => {
  const { child, port } = startServer({ APP_AUTH_TOKEN: '' });
  t.after(() => child.kill());
  await waitForServer(port);

  const bad = await fetch(`http://127.0.0.1:${port}/api/direk/assets/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(bad.status, 400);

  const missing = await fetch(`http://127.0.0.1:${port}/api/direk/assets/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'AST-wala', action: 'approve' }),
  });
  assert.equal(missing.status, 404);
});

test('the routing endpoint reports the T1/T2/T3 table and the T3 policy', async (t) => {
  const { child, port } = startServer({ APP_AUTH_TOKEN: '', T3_ALLOW_LOCAL: '0' });
  t.after(() => child.kill());
  await waitForServer(port);

  const res = await fetch(`http://127.0.0.1:${port}/api/direk/routing`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.t3_allow_local, false);
  assert.equal(body.cloud_configured, false);
  assert.ok(Array.isArray(body.table) && body.table.length > 5);

  const chat = body.table.find((r: any) => r.task === 'chat');
  const video = body.table.find((r: any) => r.task === 'video_render');
  assert.equal(chat.tier, 'T1');
  assert.equal(chat.placement, 'local');
  assert.equal(video.tier, 'T3');
  assert.equal(video.placement, 'cloud');
  assert.ok(body.tiers.T3);
});

test('video generation is offloaded, never rendered on the local GPU, when T3 is forbidden', async (t) => {
  const { child, port } = startServer({ APP_AUTH_TOKEN: '', T3_ALLOW_LOCAL: '0', CLOUD_T3_URL: '' });
  t.after(() => child.kill());
  await waitForServer(port);

  const res = await fetch(`http://127.0.0.1:${port}/api/pilot/video/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'isang bagyo', aspect_ratio: '16:9' }),
  });
  assert.equal(res.status, 503);
  const body: any = await res.json();
  assert.equal(body.route.tier, 'T3');
  assert.equal(body.route.placement, 'cloud');
  assert.equal(body.offload.job.task, 'video_render');
});

test('the LoRA plan reports where its text, image and training work will run', async (t) => {
  const { child, port } = startServer({ APP_AUTH_TOKEN: '' });
  t.after(() => child.kill());
  await waitForServer(port);

  const plan = await fetch(`http://127.0.0.1:${port}/api/direk/lora/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Ang Huling Tala', genre: 'horror', mood: 'madilim', durationMinutes: 3 }),
  });
  const body: any = await plan.json();
  assert.equal(body.routing.text.tier, 'T1');
  assert.equal(body.routing.images.tier, 'T2');
  assert.equal(body.routing.training.tier, 'T2', 'a small set trains locally');
  assert.equal(body.routing.training.placement, 'local');
});
