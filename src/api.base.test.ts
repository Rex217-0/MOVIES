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

/**
 * Both shells ship in this repo: the legacy WebView APK injects the global, the
 * Capacitor APK uses `?server=` plus localStorage. A merge once dropped the
 * global read, which would have silently sent the legacy APK back to relative
 * URLs against the APK itself. These pin the order so that cannot regress.
 */

function withStorage(runtime: string | null, fn: () => void): void {
  const g = globalThis as { localStorage?: unknown };
  const had = 'localStorage' in g;
  const before = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => (k === 'direk_server_url' ? runtime : null),
    setItem: () => {},
    removeItem: () => {},
  };
  try {
    fn();
  } finally {
    if (had) g.localStorage = before;
    else delete g.localStorage;
  }
}

test('the injected global still reaches the client, as the legacy APK needs', async () => {
  const { apiUrl } = await import('./api.js');
  withWindow({ __MOVIE_CREATOR_API_BASE__: 'http://192.168.1.10:3000/' }, () => {
    withStorage(null, () => {
      assert.equal(apiUrl('/api/pilot/status'), 'http://192.168.1.10:3000/api/pilot/status');
    });
  });
});

test('a stored runtime server wins over the injected global', async () => {
  const { apiUrl } = await import('./api.js');
  withWindow({ __MOVIE_CREATOR_API_BASE__: 'http://192.168.1.10:3000' }, () => {
    withStorage('http://10.0.0.5:3000', () => {
      assert.equal(apiUrl('/api/health'), 'http://10.0.0.5:3000/api/health');
    });
  });
});

test('with neither a stored server nor a global the path stays relative', async () => {
  const { apiUrl } = await import('./api.js');
  withWindow({}, () => {
    withStorage(null, () => {
      assert.equal(apiUrl('/api/health'), '/api/health');
    });
  });
});
