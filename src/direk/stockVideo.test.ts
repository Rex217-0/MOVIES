/**
 * Tests for the real-footage engine.
 *
 * The point of this engine is that it never invents a clip: no key means no
 * render, a non-video download is refused, and a search miss is reported rather
 * than papered over with a still image. Each case pins one of those outcomes
 * against a local server, so the HTTP behaviour is exercised for real.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ffmpegPath } from './render.ts';
import {
  commonsEnabled,
  fetchStockClip,
  pickPexelsFile,
  pixabayKey,
  pexelsKey,
  stockConfigured,
  stockQueries,
  stockQuery,
  toMp4,
} from './stockVideo.ts';

/** A minimal MP4 header plus padding, past the engine's size floor. */
function fakeClip(size = 40_000): Buffer {
  const head = Buffer.from('000000206674797069736f6d0000020069736f6d69736f32', 'hex');
  return Buffer.concat([head, Buffer.alloc(size - head.length, 7)]);
}

interface Served {
  base: string;
  hits: string[];
  close: () => Promise<void>;
}

/**
 * Serve canned responses on a real port. Routes are built from the base URL so
 * a response can point back at this same server.
 */
async function serve(
  buildRoutes: (base: string) => Record<string, { type: string; body: Buffer }>,
): Promise<Served> {
  const hits: string[] = [];
  let routes: Record<string, { type: string; body: Buffer }> = {};
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    hits.push(req.url ?? '');
    const route = routes[path];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': route.type }).end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  routes = buildRoutes(base);
  return {
    base,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Run a body with a temporary environment, restoring every key afterwards. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key]!;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const NO_KEYS = {
  PEXELS_API_KEY: undefined,
  PIXABAY_API_KEY: undefined,
  COMMONS_DISABLE: '1',
};
const NO_COMMONS = { COMMONS_DISABLE: '1' };

test('stockQuery keeps subject nouns and drops camera direction', () => {
  const q = stockQuery(
    'Cinematic film shot of a lone fisherman in a small wooden boat on a calm sea at golden hour, slow camera push in, 35mm, natural light',
  );
  assert.match(q, /fisherman/);
  assert.match(q, /boat/);
  for (const junk of ['cinematic', 'camera', '35mm', 'slow', 'shot']) {
    assert.ok(!q.includes(junk), `"${junk}" should not survive: ${q}`);
  }
  assert.ok(q.split(' ').length <= 6, `too many words: ${q}`);
});

test('stockQuery handles empty and punctuation-only prompts', () => {
  assert.equal(stockQuery(''), '');
  assert.equal(stockQuery('!!! ??? ...'), '');
  assert.equal(stockQuery('a an the'), '');
});

test('stockQuery de-duplicates repeated words', () => {
  assert.equal(stockQuery('ocean ocean ocean wave wave'), 'ocean wave');
});

test('pickPexelsFile prefers the rendition nearest 1280px', () => {
  const files = [
    { id: 1, quality: 'sd', file_type: 'video/mp4', width: 640, height: 360, link: 'a' },
    { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1280, height: 720, link: 'b' },
    { id: 3, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'c' },
  ];
  assert.equal(pickPexelsFile(files)?.width, 1280);
});

test('pickPexelsFile ignores non-mp4 and returns null when nothing fits', () => {
  const files = [
    { id: 1, quality: 'sd', file_type: 'video/webm', width: 1280, height: 720, link: 'a' },
  ];
  assert.equal(pickPexelsFile(files), null);
  assert.equal(pickPexelsFile([]), null);
});

test('no keys means not configured and no clip', async () => {
  await withEnv(NO_KEYS, async () => {
    assert.equal(stockConfigured(), false);
    assert.equal(pexelsKey(), '');
    assert.equal(pixabayKey(), '');
    assert.equal(await fetchStockClip('a fisherman at sea'), null);
  });
});

test('Pexels: a real clip is downloaded and attributed', async () => {
  const clip = fakeClip();
  const srv = await serve((base) => ({
    '/videos/search': {
      type: 'application/json',
      body: Buffer.from(JSON.stringify({
        videos: [{
          id: 7,
          url: 'https://www.pexels.com/video/7/',
          user: { name: 'Shooter' },
          video_files: [{
            id: 1, quality: 'hd', file_type: 'video/mp4',
            width: 1280, height: 720, link: `${base}/clip.mp4`,
          }],
        }],
      })),
    },
    '/clip.mp4': { type: 'video/mp4', body: clip },
  }));
  try {
    await withEnv(
      { PEXELS_API_KEY: 'k', PIXABAY_API_KEY: undefined, COMMONS_DISABLE: '1', PEXELS_API_URL: `${srv.base}/videos/search` },
      async () => {
        const hit = await fetchStockClip('fisherman boat sea');
        assert.ok(hit, 'expected a clip');
        assert.equal(hit.provider, 'pexels');
        assert.equal(hit.author, 'Shooter');
        assert.equal(hit.id, 7);
        assert.equal(hit.pageUrl, 'https://www.pexels.com/video/7/');
        assert.ok(hit.data.length >= 40_000, `too small: ${hit.data.length}`);
      },
    );
    assert.ok(srv.hits.some((h) => h.startsWith('/videos/search')), 'search was not called');
    assert.ok(srv.hits.some((h) => h.startsWith('/clip.mp4')), 'clip was not downloaded');
  } finally {
    await srv.close();
  }
});

test('Pexels: a non-video download is refused, never returned as footage', async () => {
  const srv = await serve((base) => ({
    '/videos/search': {
      type: 'application/json',
      body: Buffer.from(JSON.stringify({
        videos: [{
          id: 9,
          url: 'https://www.pexels.com/video/9/',
          user: { name: 'Wrong' },
          video_files: [{
            id: 1, quality: 'hd', file_type: 'video/mp4',
            width: 1280, height: 720, link: `${base}/notvideo.txt`,
          }],
        }],
      })),
    },
    '/notvideo.txt': { type: 'text/plain', body: Buffer.from('x'.repeat(50_000)) },
  }));
  try {
    await withEnv(
      { PEXELS_API_KEY: 'k', PIXABAY_API_KEY: undefined, COMMONS_DISABLE: '1', PEXELS_API_URL: `${srv.base}/videos/search` },
      async () => {
        await assert.rejects(
          () => fetchStockClip('fisherman'),
          /walang tugmang video|Hindi video/,
          'a text file must never be accepted as a clip',
        );
      },
    );
  } finally {
    await srv.close();
  }
});

test('Pexels: a search miss throws with the query, not a fake clip', async () => {
  const srv = await serve(() => ({
    '/videos/search': { type: 'application/json', body: Buffer.from(JSON.stringify({ videos: [] })) },
  }));
  try {
    await withEnv(
      { PEXELS_API_KEY: 'k', PIXABAY_API_KEY: undefined, COMMONS_DISABLE: '1', PEXELS_API_URL: `${srv.base}/videos/search` },
      async () => {
        await assert.rejects(() => fetchStockClip('walang tugma ito'), /walang tugmang video/);
      },
    );
  } finally {
    await srv.close();
  }
});

test('Pexels: an HTTP error is reported, not swallowed', async () => {
  const srv = await serve(() => ({}));
  try {
    await withEnv(
      { PEXELS_API_KEY: 'k', PIXABAY_API_KEY: undefined, COMMONS_DISABLE: '1', PEXELS_API_URL: `${srv.base}/videos/search` },
      async () => {
        await assert.rejects(() => fetchStockClip('fisherman'), /HTTP 404/);
      },
    );
  } finally {
    await srv.close();
  }
});

test('Pixabay is used when Pexels is not configured', async () => {
  const clip = fakeClip();
  const srv = await serve((base) => ({
    '/api/videos/': {
      type: 'application/json',
      body: Buffer.from(JSON.stringify({
        hits: [{
          id: 11,
          pageURL: 'https://pixabay.com/video/11/',
          user: 'PixShooter',
          videos: { medium: { url: `${base}/clip.mp4`, width: 1280, height: 720 } },
        }],
      })),
    },
    '/clip.mp4': { type: 'video/mp4', body: clip },
  }));
  try {
    await withEnv(
      { PEXELS_API_KEY: undefined, PIXABAY_API_KEY: 'k', COMMONS_DISABLE: '1', PIXABAY_API_URL: `${srv.base}/api/videos/` },
      async () => {
        const hit = await fetchStockClip('fisherman boat sea');
        assert.ok(hit, 'expected a clip');
        assert.equal(hit.provider, 'pixabay');
        assert.equal(hit.author, 'PixShooter');
        assert.equal(hit.id, 11);
      },
    );
  } finally {
    await srv.close();
  }
});

test('an empty query is refused before any HTTP call', async () => {
  await withEnv({ PEXELS_API_KEY: 'k', PIXABAY_API_KEY: undefined, COMMONS_DISABLE: '1' }, async () => {
    await assert.rejects(() => fetchStockClip('a an the'), /Walang makuhang search term/);
  });
});

test('stockQuery strips camera jargon glued to numbers', () => {
  const q = stockQuery('35mm shot of a tiger 24fps 4k');
  assert.ok(!q.includes('35'), q);
  assert.ok(!q.includes('24'), q);
  assert.match(q, /tiger/);
});

test('stockQueries loosens progressively and never repeats', () => {
  const qs = stockQueries('ocean surface waves golden hour');
  assert.ok(qs.length >= 2, `expected fallbacks: ${JSON.stringify(qs)}`);
  assert.equal(qs[0], 'ocean surface waves');
  assert.equal(new Set(qs).size, qs.length, `duplicates: ${JSON.stringify(qs)}`);
  for (const q of qs) assert.ok(q.length > 0);
});

test('stockQueries returns nothing for an empty prompt', () => {
  assert.deepEqual(stockQueries('a an the'), []);
});

test('Commons is enabled by default and can be switched off', async () => {
  await withEnv({ COMMONS_DISABLE: undefined }, async () => {
    assert.equal(commonsEnabled(), true);
    assert.equal(stockConfigured(), true, 'real footage must work with no key at all');
  });
  await withEnv({ COMMONS_DISABLE: '1' }, async () => {
    assert.equal(commonsEnabled(), false);
  });
});

test('Commons: a real clip is downloaded and its licence recorded', async () => {
  const clip = fakeClip();
  // The API is two calls with different params, so answer by inspecting the URL.
  const hits: string[] = [];
  const apiServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    hits.push(url.search);
    if (url.searchParams.get('list') === 'search') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        query: { search: [{ title: 'File:Ocean waves.ogv' }] },
      }));
      return;
    }
    if (url.pathname === '/clip.webm') {
      res.writeHead(200, { 'Content-Type': 'video/webm' }).end(clip);
      return;
    }
    if (url.searchParams.get('prop') === 'videoinfo') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        query: {
          pages: {
            42: {
              pageid: 42,
              title: 'File:Ocean waves.ogv',
              videoinfo: [{
                url: `${base}/clip.webm`,
                size: 60_000_000,
                duration: 12,
                derivatives: [{ src: `${base}/clip.webm`, type: 'video/webm', width: 854, height: 480 }],
                extmetadata: {
                  Artist: { value: '<a href="#">Real Shooter</a>' },
                  LicenseShortName: { value: 'CC0' },
                },
              }],
            },
          },
        },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  const addr = apiServer.address();
  const apiPort = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${apiPort}`;
  try {
    await withEnv(
      {
        PEXELS_API_KEY: undefined,
        PIXABAY_API_KEY: undefined,
        COMMONS_DISABLE: undefined,
        WIKIMEDIA_API_URL: `http://127.0.0.1:${apiPort}/w/api.php`,
      },
      async () => {
        const hit = await fetchStockClip('ocean waves');
        assert.ok(hit, 'expected real footage from Commons');
        assert.equal(hit.provider, 'commons');
        assert.equal(hit.author, 'Real Shooter', 'HTML must be stripped from the credit');
        assert.equal(hit.licence, 'CC0');
        assert.equal(hit.id, 42);
        assert.ok(hit.data.length >= 40_000);
        assert.match(hit.pageUrl, /commons\.wikimedia\.org/);
      },
    );
    assert.ok(hits.some((h) => h.includes('list=search')), 'search call missing');
    assert.ok(hits.some((h) => h.includes('videoinfo')), 'videoinfo call missing');
  } finally {
    await new Promise<void>((r) => apiServer.close(() => r()));
  }
});

test('toMp4 passes an MP4 through untouched', async () => {
  const mp4 = fakeClip();
  const out = await toMp4(mp4);
  assert.equal(out, mp4, 'an MP4 must not be re-encoded');
});

test('toMp4 transcodes a non-MP4 container into H.264 MP4', async () => {
  // Build a real WebM with ffmpeg so the transcode is exercised for real.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'totest-'));
  const webm = path.join(dir, 'in.webm');
  try {
    execFileSync(ffmpegPath(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=3',
      '-c:v', 'libvpx', '-b:v', '300k', webm,
    ]);
    const out = await toMp4(fs.readFileSync(webm));
    assert.equal(out.subarray(4, 8).toString('latin1'), 'ftyp', 'output must be MP4');
    assert.ok(out.length >= 20_000, `too small: ${out.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Commons: a provider that never answers cannot stall the search forever', async () => {
  // A fan-out over queries x hits x candidate URLs x retries is unbounded on
  // its own: against a throttled provider it ran for hours. The search must
  // give up within its budget so the caller can fall back to the free engine.
  const sockets: net.Socket[] = [];
  const apiServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('list') === 'search') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        query: { search: [{ title: 'File:Ocean waves.ogv' }] },
      }));
      return;
    }
    if (url.searchParams.get('prop') === 'videoinfo') {
      const base = `http://127.0.0.1:${(apiServer.address() as net.AddressInfo).port}`;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        query: {
          pages: {
            42: {
              pageid: 42,
              title: 'File:Ocean waves.ogv',
              videoinfo: [{
                url: `${base}/clip.webm`,
                size: 60_000_000,
                duration: 12,
                derivatives: [{ src: `${base}/clip.webm`, type: 'video/webm', width: 854, height: 480 }],
                extmetadata: {},
              }],
            },
          },
        },
      }));
      return;
    }
    // The clip URL never answers: headers only, no body, no end.
    res.writeHead(200, { 'Content-Type': 'video/webm' });
    sockets.push(req.socket);
  });
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  const port = (apiServer.address() as net.AddressInfo).port;
  const started = Date.now();
  try {
    await withEnv(
      {
        PEXELS_API_KEY: undefined,
        PIXABAY_API_KEY: undefined,
        COMMONS_DISABLE: undefined,
        WIKIMEDIA_API_URL: `http://127.0.0.1:${port}/w/api.php`,
        STOCK_SEARCH_BUDGET_MS: '1500',
        STOCK_DOWNLOAD_TIMEOUT_MS: '500',
      },
      async () => {
        await assert.rejects(
          () => fetchStockClip('ocean waves'),
          /lumampas sa .* na budget|walang tugmang video/,
          'a stalled provider must surface as a bounded failure',
        );
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30_000, `search took ${elapsed}ms; the budget did not apply`);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => apiServer.close(() => r()));
  }
});
