import test from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl, normalizeApiBaseUrl, resolveApiBaseUrl } from './api';

/**
 * The Android build (Capacitor) loads the web app from `https://localhost`, so a
 * relative `/api/...` URL would hit the WebView instead of Server-2. These
 * checks pin the join logic that makes `VITE_API_BASE_URL` work, and confirm the
 * same-origin browser build is unchanged when the base is empty.
 */

test('an empty base keeps URLs relative, so the served browser build is unchanged', () => {
  assert.equal(apiUrl('/api/health', ''), '/api/health');
  assert.equal(apiUrl('/api/pilot/thought-stream?ticket=abc', ''), '/api/pilot/thought-stream?ticket=abc');
});

test('a configured base is prefixed onto an API path', () => {
  assert.equal(apiUrl('/api/health', 'http://192.0.2.10:3000'), 'http://192.0.2.10:3000/api/health');
  assert.equal(
    apiUrl('/api/direk/assets/x/download?token=t', 'https://server.example'),
    'https://server.example/api/direk/assets/x/download?token=t',
  );
});

test('a trailing slash on the base never produces a double slash', () => {
  assert.equal(normalizeApiBaseUrl('http://192.0.2.10:3000/'), 'http://192.0.2.10:3000');
  assert.equal(apiUrl('/api/health', normalizeApiBaseUrl('http://192.0.2.10:3000///')), 'http://192.0.2.10:3000/api/health');
});

test('absolute URLs and non-paths pass through untouched', () => {
  assert.equal(apiUrl('https://cdn.example/a.png', 'http://192.0.2.10:3000'), 'https://cdn.example/a.png');
  assert.equal(apiUrl('data:image/png;base64,AAAA', 'http://192.0.2.10:3000'), 'data:image/png;base64,AAAA');
});

test('surrounding whitespace in the env value is ignored', () => {
  assert.equal(normalizeApiBaseUrl('  http://192.0.2.10:3000  '), 'http://192.0.2.10:3000');
  assert.equal(normalizeApiBaseUrl(undefined), '');
  assert.equal(normalizeApiBaseUrl(null), '');
});

test('a runtime server override wins over the baked build value', () => {
  assert.equal(resolveApiBaseUrl('http://192.168.1.10:3000', 'http://192.0.2.10:3000'), 'http://192.168.1.10:3000');
});

test('with no override the baked build value is used', () => {
  assert.equal(resolveApiBaseUrl('', 'http://192.0.2.10:3000'), 'http://192.0.2.10:3000');
  assert.equal(resolveApiBaseUrl(null, 'http://192.0.2.10:3000/'), 'http://192.0.2.10:3000');
  assert.equal(resolveApiBaseUrl('  ', undefined), '');
});

test('a trailing slash in the override is stripped before the join', () => {
  const base = resolveApiBaseUrl('http://192.168.1.10:3000///', 'http://192.0.2.10:3000');
  assert.equal(apiUrl('/api/direk/movie/status', base), 'http://192.168.1.10:3000/api/direk/movie/status');
});
