import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The Android shell loads the UI from inside the APK, where a relative /api
 * would resolve against the APK itself. These tests pin the contract between
 * the shell (which injects the global) and the client (which must honour it).
 */

function withWindow(value: unknown, fn: () => void): void {
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const before = g.window;
  g.window = value;
  try {
    fn();
  } finally {
    if (had) g.window = before;
    else delete g.window;
  }
}

test('apiUrl keeps a relative path when no shell base is injected', async () => {
  const { apiUrl } = await import('./api.js');
  withWindow({}, () => {
    assert.equal(apiUrl('/api/pilot/status'), '/api/pilot/status');
  });
});

test('apiUrl prefixes the injected server and trims trailing slashes', async () => {
  const { apiUrl } = await import('./api.js');
  withWindow({ __MOVIE_CREATOR_API_BASE__: 'http://192.168.1.10:3000/' }, () => {
    assert.equal(apiUrl('/api/pilot/status'), 'http://192.168.1.10:3000/api/pilot/status');
  });
});

test('apiUrl ignores an empty or whitespace base', async () => {
  const { apiUrl } = await import('./api.js');
  withWindow({ __MOVIE_CREATOR_API_BASE__: '   ' }, () => {
    assert.equal(apiUrl('/api/pilot/status'), '/api/pilot/status');
  });
});

test('apiUrl leaves absolute URLs alone', async () => {
  const { apiUrl } = await import('./api.js');
  withWindow({ __MOVIE_CREATOR_API_BASE__: 'http://host:3000' }, () => {
    assert.equal(apiUrl('https://cdn.example/x.mp4'), 'https://cdn.example/x.mp4');
  });
});
