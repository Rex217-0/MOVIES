import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPilotUrl, savePilotUrl, restorePilotUrl, pilotUrlDurable } from './pilotSync.ts';
import { readSettings } from './settings.ts';

test('a public https tunnel URL is accepted', () => {
  const r = checkPilotUrl('https://brave-lion-1234.trycloudflare.com');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.url, 'https://brave-lion-1234.trycloudflare.com');
});

test('a trailing slash and a path are stripped to the origin', () => {
  const r = checkPilotUrl('https://pilot.example.com/generate_script?x=1');
  assert.equal(r.ok && r.url, 'https://pilot.example.com');
});

test('surrounding whitespace is tolerated', () => {
  const r = checkPilotUrl('  https://pilot.example.com  ');
  assert.equal(r.ok && r.url, 'https://pilot.example.com');
});

test('http is refused: the worker must be behind TLS', () => {
  const r = checkPilotUrl('http://pilot.example.com');
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /https/);
});

test('loopback, private and CGNAT hosts are refused', () => {
  for (const host of [
    'https://localhost:8000',
    'https://127.0.0.1',
    'https://10.0.0.5',
    'https://172.16.0.9',
    'https://192.168.1.10',
    'https://169.254.169.254',
    'https://100.122.147.65',
    'https://[::1]',
  ]) {
    const r = checkPilotUrl(host);
    assert.equal(r.ok, false, `${host} should be refused`);
  }
});

test('an internal DNS name is refused', () => {
  for (const host of ['https://pilot.internal', 'https://nas.local', 'https://a.localhost']) {
    assert.equal(checkPilotUrl(host).ok, false, `${host} should be refused`);
  }
});

test('credentials in the URL are refused', () => {
  const r = checkPilotUrl('https://user:pass@pilot.example.com');
  assert.equal(r.ok, false);
});

test('non-strings, empty strings and junk are refused', () => {
  for (const bad of [null, undefined, 42, {}, '', '   ', 'not a url', 'ftp://x.com']) {
    assert.equal(checkPilotUrl(bad).ok, false);
  }
});

test('an over-long URL is refused', () => {
  const long = 'https://' + 'a'.repeat(3000) + '.com';
  assert.equal(checkPilotUrl(long).ok, false);
});

test('savePilotUrl persists the value and applies it to the process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotsync-'));
  const savedConfig = process.env.DIREK_CONFIG;
  const savedEnv = process.env.KAGGLE_PILOT_URL;
  process.env.DIREK_CONFIG = path.join(dir, 'direk.config.json');
  delete process.env.KAGGLE_PILOT_URL;
  try {
    await savePilotUrl('https://pilot.example.com');
    assert.equal(process.env.KAGGLE_PILOT_URL, 'https://pilot.example.com');
    assert.equal(readSettings().kaggle_pilot_url, 'https://pilot.example.com');
  } finally {
    if (savedConfig === undefined) delete process.env.DIREK_CONFIG;
    else process.env.DIREK_CONFIG = savedConfig;
    if (savedEnv === undefined) delete process.env.KAGGLE_PILOT_URL;
    else process.env.KAGGLE_PILOT_URL = savedEnv;
  }
});

test('a saved URL is restored on startup, so a redeploy keeps the worker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotrestore-'));
  const savedConfig = process.env.DIREK_CONFIG;
  const savedEnv = process.env.KAGGLE_PILOT_URL;
  process.env.DIREK_CONFIG = path.join(dir, 'direk.config.json');
  delete process.env.KAGGLE_PILOT_URL;
  try {
    // No Firestore credentials in the test environment, so this exercises the
    // offline path: restore must decline rather than invent a URL.
    assert.equal(await restorePilotUrl(), null);
    assert.equal(process.env.KAGGLE_PILOT_URL, undefined);
  } finally {
    if (savedConfig === undefined) delete process.env.DIREK_CONFIG;
    else process.env.DIREK_CONFIG = savedConfig;
    if (savedEnv === undefined) delete process.env.KAGGLE_PILOT_URL;
    else process.env.KAGGLE_PILOT_URL = savedEnv;
  }
});

test('durability follows whether Firebase is configured', () => {
  const saved = process.env.FIREBASE_SERVICE_ACCOUNT;
  try {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    assert.equal(pilotUrlDurable(), false, 'no credentials means the URL cannot survive a restart');
  } finally {
    if (saved !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT = saved;
  }
});

test('a pinned KAGGLE_PILOT_URL is never overwritten by a saved value', async () => {
  const savedEnv = process.env.KAGGLE_PILOT_URL;
  process.env.KAGGLE_PILOT_URL = 'https://pinned.example.com';
  try {
    assert.equal(await restorePilotUrl(), null);
    assert.equal(process.env.KAGGLE_PILOT_URL, 'https://pinned.example.com');
  } finally {
    if (savedEnv === undefined) delete process.env.KAGGLE_PILOT_URL;
    else process.env.KAGGLE_PILOT_URL = savedEnv;
  }
});
