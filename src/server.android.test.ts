import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * The Android APK serves its UI from https://app.local, a host the shell owns.
 * A file:// page would send "Origin: null", which no server can allow safely,
 * so the shell uses a fixed origin instead and the server must accept it while
 * still refusing everyone else. These tests run the real server, because the
 * behaviour lives in its middleware, not in a function.
 */

function startServer(env: Record<string, string>) {
  const port = 4900 + Math.floor(Math.random() * 400);
  const child = spawn('node', ['server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      GEMINI_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      // Blank the Fish keys too. dotenv loads .env into the child, and a real
      // key here makes a test call the live TTS API once per scene.
      FISH_AUDIO_API_KEY: '',
      LANSA_FISH_TOKEN: '',
      DIREK_CONFIG: path.join(repoRoot, '.no-such-config.json'),
      OLLAMA_DISABLE: '1',
      FAL_KEY: '',
      OPENCUT_ENDPOINT: '',
      ALLOWED_ORIGINS: '',
      ...env,
    },
    stdio: 'ignore',
  });
  return { child, port };
}

async function waitForServer(port: number) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server on ${port} did not start`);
}

test('the Android shell origin can call the API, and other sites still cannot', async () => {
  const { child, port } = startServer({});
  try {
    await waitForServer(port);

    const shell = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: 'https://app.local' },
    });
    assert.equal(shell.status, 200, 'the APK origin must be allowed');
    assert.equal(
      shell.headers.get('access-control-allow-origin'),
      'https://app.local',
      'the shell needs its exact origin echoed back, not a wildcard',
    );

    const evil = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(evil.status, 403, 'an unknown site must still be refused');

    const preflight = await fetch(`http://127.0.0.1:${port}/api/pilot/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.local',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(preflight.status, 204, 'the shell sends a JSON POST with a bearer token');
    assert.match(
      preflight.headers.get('access-control-allow-headers') || '',
      /Authorization/i,
    );
  } finally {
    child.kill();
  }
});
