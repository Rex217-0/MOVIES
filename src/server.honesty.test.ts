import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function startServer(env: Record<string, string>) {
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn('node', ['server.ts'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), GEMINI_API_KEY: '', ...env },
    stdio: 'ignore',
  });
  return { child, port };
}

async function waitForServer(port: number, headers: Record<string, string> = {}) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

test('without a Gemini key, AI endpoints return 503 AI_UNAVAILABLE instead of fake success', async (t) => {
  const { child, port } = startServer({ APP_AUTH_TOKEN: '' });
  t.after(() => child.kill());
  await waitForServer(port);

  const command = await fetch(`http://127.0.0.1:${port}/api/pilot/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directive: 'scan the sector' }),
  });
  assert.equal(command.status, 503);
  const commandBody: any = await command.json();
  assert.equal(commandBody.code, 'AI_UNAVAILABLE');
  assert.equal(commandBody.status, undefined);
  assert.equal(commandBody.model, 'gemini-2.5-flash');

  const video = await fetch(`http://127.0.0.1:${port}/api/pilot/video/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'a cruiser', aspect_ratio: '16:9' }),
  });
  assert.equal(video.status, 503);
  assert.equal((await video.json() as any).code, 'AI_UNAVAILABLE');

  const image = await fetch(`http://127.0.0.1:${port}/api/pilot/image/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'a cruiser' }),
  });
  assert.equal(image.status, 503);
  assert.equal((await image.json() as any).code, 'AI_UNAVAILABLE');
});

test('when a token is configured, /api routes reject requests without it', async (t) => {
  const { child, port } = startServer({ APP_AUTH_TOKEN: 'test-token' });
  t.after(() => child.kill());
  await waitForServer(port, { Authorization: 'Bearer test-token' });

  const anon = await fetch(`http://127.0.0.1:${port}/api/pilot/status`);
  assert.equal(anon.status, 401);

  const authed = await fetch(`http://127.0.0.1:${port}/api/pilot/status`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(authed.status, 200);
});

test('the gallery never fabricates a url for preset items', async (t) => {
  const { child, port } = startServer({ APP_AUTH_TOKEN: '' });
  t.after(() => child.kill());
  await waitForServer(port);

  const res = await fetch(`http://127.0.0.1:${port}/api/pilot/media/gallery`);
  const body: any = await res.json();
  for (const item of body.items) {
    if (item.id.startsWith('VID-PRESET') || item.id.startsWith('IMG-PRESET')) {
      assert.equal(item.url, '', `${item.id} must not carry a fabricated url`);
      assert.equal(item.model, 'placeholder');
    }
  }
});

test('LoRA endpoints work with no model and honestly skip images', async (t) => {
  const { child, port } = startServer({ APP_AUTH_TOKEN: '' });
  t.after(() => child.kill());
  await waitForServer(port);

  const brief = { title: 'Ang Huling Tala', genre: 'horror', mood: 'madilim', durationMinutes: 4 };

  const plan = await fetch(`http://127.0.0.1:${port}/api/direk/lora/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(brief),
  });
  assert.equal(plan.status, 200);
  const planBody: any = await plan.json();
  assert.equal(planBody.trigger, 'direk_ang_huling_tala');
  assert.equal(planBody.samples, 8);
  assert.equal(planBody.images_available, false, 'no paid image model without a key');
  assert.ok(planBody.references.length > 0);

  const ds = await fetch(`http://127.0.0.1:${port}/api/direk/lora/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(brief),
  });
  assert.equal(ds.status, 200);
  assert.match(ds.headers.get('content-type') || '', /zip/);
  const zip = Buffer.from(await ds.arrayBuffer());
  assert.equal(zip.subarray(0, 2).toString(), 'PK');

  const missing = await fetch(`http://127.0.0.1:${port}/api/direk/lora/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'X' }),
  });
  assert.equal(missing.status, 400);
});

test('with a ComfyUI backend, the LoRA set bundles generated images', async (t) => {
  // A stand-in for a local ComfyUI server: accepts a prompt, then serves one
  // image back. This exercises the whole free image path without a GPU.
  const { createServer } = await import('node:http');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  let seq = 0;
  const comfy = createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/system_stats')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ system: { comfyui_version: 'mock' } }));
    } else if (url.startsWith('/history/')) {
      const id = url.split('/history/')[1];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ [id]: { outputs: { 9: { images: [{ filename: `${id}.png`, subfolder: '', type: 'output' }] } }, status: { status_str: 'success' } } }));
    } else if (url.startsWith('/view')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
    } else if (url.startsWith('/prompt')) {
      const id = `p${++seq}`;
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: id }));
      });
    } else {
      res.writeHead(404); res.end('{}');
    }
  });
  await new Promise<void>(r => comfy.listen(0, '127.0.0.1', r));
  t.after(() => comfy.close());
  const comfyPort = (comfy.address() as any).port;

  const { child, port } = startServer({
    APP_AUTH_TOKEN: '',
    COMFYUI_URL: `http://127.0.0.1:${comfyPort}`,
  });
  t.after(() => child.kill());
  await waitForServer(port);

  const brief = { title: 'Ang Huling Tala', genre: 'horror', mood: 'madilim', durationMinutes: 3 };

  const plan = await fetch(`http://127.0.0.1:${port}/api/direk/lora/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(brief),
  });
  const planBody: any = await plan.json();
  assert.equal(planBody.image_backend, 'comfyui');
  assert.equal(planBody.images_available, true);

  const ds = await fetch(`http://127.0.0.1:${port}/api/direk/lora/dataset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(brief),
  });
  assert.equal(ds.status, 200);
  const zip = Buffer.from(await ds.arrayBuffer());

  // Read the central directory the same way the zip reader does.
  const eocd = zip.length - 22;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = zip.readUInt16LE(p + 28);
    names.push(zip.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  const pngs = names.filter(n => n.endsWith('.png'));
  assert.equal(pngs.length, 6, `expected 6 images, got ${pngs.length}`);
  assert.ok(names.includes('dataset/direk_ang_huling_tala_001.png'));
  assert.ok(names.includes('dataset/direk_ang_huling_tala_001.txt'));
  assert.ok(names.includes('dataset/IMAGES.md'));
});
