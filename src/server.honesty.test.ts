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
