/**
 * Real tests for the Season 1 harvester, registry and dataset scanner.
 *
 * Every network path runs against a real local HTTP server, so the URL building,
 * the response parsing, the download, the PNG re-encode and the numbering are all
 * exercised for real. Nothing here is mocked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cleanImageUrl,
  harvestImagesForLora,
  nextFreeIndex,
  parseCandidates,
  queryLadder,
  HARVEST_SOURCES,
} from './loraHarvester.ts';
import { listDatasets, readDataset } from './datasets.ts';
import { ExtensionRegistry } from '../registry.ts';
import type { MovieCreatorExtension } from '../contract.ts';
import { seedDataset, STARTER_CAPTIONS, TRIGGER } from './starterDataset.ts';

/**
 * A real 96x96 PNG made by ffmpeg. Small enough to inline, but a genuine image,
 * so the harvester's own magic-byte check and the ffmpeg re-encode both run for
 * real rather than against a stand-in.
 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAACXBIWXMAAAABAAAAAQBPJcTWAAAApElEQVR4nO3QQQ0AIBDAsNOCJ/xLAQd82aPJBCydtY8ezfeDeIAAAQIEKBwgQIAAAQoHCBAgQIDCAQIECBCgcIAAAQIEKBwgQIAAAQoHCBAgQIDCAQIECBCgcIAAAQIEKBwgQIAAAQoHCBAgQIDCAQIECBCgcIAAAQIEKBwgQIAAAQoHCBAgQIDCAQIECBCgcIAAAQIEKBwgQIAAAQoHCBAgQD+73SybDfCwhKgAAAAASUVORK5CYII=',
  'base64',
);

/**
 * A real JPEG made by ffmpeg, so the re-encode path is proven on a genuine
 * non-PNG source instead of a fake header.
 */
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzU4LjQyLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABNAAEBAAAAAAAAAAAAAAAAAAAAAwEBAQEAAAAAAAAAAAAAAAAAAAYHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAYABgAwESAAISAAMSAP/aAAwDAQACEQMRAD8AmNKEWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9k=',
  'base64',
);

interface FakeApis {
  base: string;
  close: () => Promise<void>;
  /** Every path the harvester asked for, so URL building can be asserted. */
  requests: string[];
  /** How many image downloads were served. */
  downloads: number;
}

/**
 * Serve the three real API shapes plus their images over one local server.
 * `opts.empty` makes every search return zero results; `opts.broken` makes the
 * search return 500, which is how a dead mine behaves.
 */
function startApis(opts: { empty?: boolean; broken?: boolean; jpeg?: boolean } = {}): Promise<FakeApis> {
  const requests: string[] = [];
  const state = { downloads: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    requests.push(url.pathname + url.search);

    if (url.pathname.startsWith('/img')) {
      state.downloads += 1;
      const body = opts.jpeg ? JPEG_1PX : PNG_1PX;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(body);
      return;
    }
    if (opts.broken) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    if (opts.empty) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], results: [], query: { pages: {} } }));
      return;
    }

    // Each mine gets its own id space so every candidate is a distinct URL.
    if (url.pathname === '/wallhaven') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: Array.from({ length: 5 }, (_, i) => ({
          path: `http://${req.headers.host}/img/wh-${i}.png`,
          dimension_x: 1920,
          dimension_y: 1080,
          url: `https://wallhaven.cc/w/wh-${i}`,
        })),
      }));
      return;
    }
    if (url.pathname === '/openverse') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        results: Array.from({ length: 5 }, (_, i) => ({
          url: `http://${req.headers.host}/img/ov-${i}.png`,
          width: 1200,
          height: 900,
          foreign_landing_url: `https://openverse.org/i/ov-${i}`,
        })),
      }));
      return;
    }
    if (url.pathname === '/wikimedia') {
      const pages: Record<string, unknown> = {};
      for (let i = 0; i < 5; i += 1) {
        pages[String(i)] = {
          imageinfo: [{
            url: `http://${req.headers.host}/img/wm-${i}.png?utm_source=commons&utm_campaign=x`,
            width: 1600,
            height: 1200,
            descriptionurl: `https://commons.wikimedia.org/wiki/File:wm-${i}.png`,
          }],
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ query: { pages } }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
        requests,
        get downloads() { return state.downloads; },
      });
    });
  });
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-test-'));
}

function endpointsFor(apis: FakeApis) {
  return {
    wallhaven: `${apis.base}/wallhaven`,
    openverse: `${apis.base}/openverse`,
    wikimedia: `${apis.base}/wikimedia`,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('queryLadder drops trailing words until one term is left', () => {
  assert.deepEqual(queryLadder('a b c'), ['a b c', 'a b', 'a']);
  assert.deepEqual(queryLadder('  spaced   out  '), ['spaced out', 'spaced']);
  assert.deepEqual(queryLadder(''), []);
});

test('cleanImageUrl strips the Wikimedia utm_ marketing params', () => {
  const cleaned = cleanImageUrl('https://upload.wikimedia.org/a/b.png?utm_source=commons&utm_campaign=imageinfo&keep=1');
  assert.equal(cleaned, 'https://upload.wikimedia.org/a/b.png?keep=1');
  assert.equal(cleanImageUrl(''), '');
});

test('parseCandidates reads each real API shape and skips undersized images', () => {
  const wallhaven = parseCandidates('wallhaven', {
    data: [{ path: 'https://w/1.jpg', dimension_x: 1920, dimension_y: 1080, url: 'page' }],
  }, 'q');
  assert.equal(wallhaven.length, 1);
  assert.equal(wallhaven[0].width, 1920);

  const openverse = parseCandidates('openverse', {
    results: [
      { url: 'https://o/big.jpg', width: 1600, height: 1200 },
      { url: 'https://o/small.jpg', width: 200, height: 200 },
    ],
  }, 'q');
  assert.equal(openverse.length, 1, 'a tiny image must be filtered out');
  assert.match(openverse[0].url, /big\.jpg/);

  const wikimedia = parseCandidates('wikimedia', {
    query: { pages: { '1': { imageinfo: [{ url: 'https://u/c.png?utm_source=x', width: 1600, height: 900 }] } } },
  }, 'q');
  assert.equal(wikimedia.length, 1);
  assert.equal(wikimedia[0].url, 'https://u/c.png');
});

test('nextFreeIndex continues after the highest existing sample', () => {
  const dir = tmpRoot();
  assert.equal(nextFreeIndex(dir, 'tok'), 1);
  fs.writeFileSync(path.join(dir, 'tok_001.png'), PNG_1PX);
  fs.writeFileSync(path.join(dir, 'tok_007.png'), PNG_1PX);
  fs.writeFileSync(path.join(dir, 'tok_003.txt'), 'x');
  assert.equal(nextFreeIndex(dir, 'tok'), 8);
});

// ---------------------------------------------------------------------------
// End-to-end harvest against a real server
// ---------------------------------------------------------------------------

test('harvest writes real PNGs and captions from all three mines', async () => {
  const apis = await startApis();
  const dir = tmpRoot();
  try {
    const result = await harvestImagesForLora({
      query: 'cyberpunk neon',
      triggerToken: 'test_tok',
      count: 6,
      targetDir: dir,
      endpoints: endpointsFor(apis),
    });

    assert.equal(result.saved, 6);
    assert.deepEqual([...result.sourcesAnswered].sort(), [...HARVEST_SOURCES].sort());

    // Round-robin: the set is spread across the mines, not filled by one.
    const bySource = result.samples.reduce<Record<string, number>>((acc, s) => {
      acc[s.source] = (acc[s.source] || 0) + 1;
      return acc;
    }, {});
    assert.equal(Object.keys(bySource).length, 3, `expected 3 sources, got ${JSON.stringify(bySource)}`);

    for (const sample of result.samples) {
      const bytes = fs.readFileSync(path.join(dir, sample.file));
      assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${sample.file} is not a real PNG`);
      const caption = fs.readFileSync(path.join(dir, sample.captionFile), 'utf8');
      assert.match(caption, /^test_tok, cyberpunk neon/);
    }
    assert.deepEqual(
      fs.readdirSync(dir).filter(f => f.startsWith('.harvest-')),
      [],
      'the scratch folder must be cleaned up',
    );
  } finally {
    await apis.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a JPEG source is re-encoded into a genuine PNG', async () => {
  const apis = await startApis({ jpeg: true });
  const dir = tmpRoot();
  try {
    const result = await harvestImagesForLora({
      query: 'neon', triggerToken: 'test_tok', count: 1, targetDir: dir, endpoints: endpointsFor(apis),
    });
    assert.equal(result.saved, 1);
    const bytes = fs.readFileSync(path.join(dir, result.samples[0].file));
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await apis.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing sample is never overwritten', async () => {
  const apis = await startApis();
  const dir = tmpRoot();
  try {
    const first = await harvestImagesForLora({
      query: 'neon', triggerToken: 'test_tok', count: 2, targetDir: dir, endpoints: endpointsFor(apis),
    });
    assert.equal(first.saved, 2);

    const second = await harvestImagesForLora({
      query: 'neon', triggerToken: 'test_tok', count: 2, targetDir: dir, endpoints: endpointsFor(apis),
    });
    assert.deepEqual(second.samples.map(s => s.file), ['test_tok_003.png', 'test_tok_004.png']);
    const all = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
    assert.equal(all.length, 4);
  } finally {
    await apis.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead mine does not stop the others', async () => {
  const apis = await startApis();
  const dir = tmpRoot();
  try {
    const endpoints = { ...endpointsFor(apis), openverse: `${apis.base}/missing` };
    const result = await harvestImagesForLora({
      query: 'neon', triggerToken: 'test_tok', count: 4, targetDir: dir, endpoints,
    });
    assert.ok(result.saved > 0, 'the healthy mines still delivered');
    assert.ok(!result.sourcesAnswered.includes('openverse'));
    assert.ok(result.failures.some(f => f.source === 'openverse'));
  } finally {
    await apis.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty search saves nothing and says so', async () => {
  const apis = await startApis({ empty: true });
  const dir = tmpRoot();
  try {
    const result = await harvestImagesForLora({
      query: 'wala talaga', triggerToken: 'test_tok', count: 3, targetDir: dir, endpoints: endpointsFor(apis),
    });
    assert.equal(result.saved, 0);
    assert.equal(result.samples.length, 0);
    assert.match(result.note, /walang nahanap na larawan/);
    assert.doesNotMatch(result.note, /bigo/, 'an empty search is not a failure');
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.png')).length, 0);
  } finally {
    await apis.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid trigger token is rejected before any download', async () => {
  const apis = await startApis();
  const dir = tmpRoot();
  try {
    await assert.rejects(
      () => harvestImagesForLora({
        query: 'neon', triggerToken: 'Not Valid!', count: 1, targetDir: dir, endpoints: endpointsFor(apis),
      }),
      /Invalid trigger token/,
    );
    assert.equal(apis.downloads, 0, 'nothing may be downloaded for a bad token');
  } finally {
    await apis.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the ladder retries a shorter query when the full one is empty', async () => {
  const dir = tmpRoot();
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (u.pathname.startsWith('/img')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG_1PX);
      return;
    }
    const q = u.searchParams.get('q') || '';
    seen.push(q);
    // Only the single-word query has results.
    const has = q.trim().split(/\s+/).length === 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: has ? [{ path: `http://${req.headers.host}/img/a.png`, dimension_x: 1920, dimension_y: 1080 }] : [],
    }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  try {
    const result = await harvestImagesForLora({
      query: 'very long query',
      triggerToken: 'test_tok',
      count: 1,
      targetDir: dir,
      endpoints: { wallhaven: `http://127.0.0.1:${port}/w`, openverse: `http://127.0.0.1:${port}/none`, wikimedia: `http://127.0.0.1:${port}/none2` },
    });
    assert.ok(seen.includes('very long query'));
    assert.ok(seen.includes('very'), `ladder never shortened; saw ${JSON.stringify(seen)}`);
    assert.equal(result.saved, 1);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Dataset scanner
// ---------------------------------------------------------------------------

test('readDataset counts images, captions and the mismatches honestly', () => {
  const dir = tmpRoot();
  try {
    fs.writeFileSync(path.join(dir, 'a_001.png'), PNG_1PX);
    fs.writeFileSync(path.join(dir, 'a_001.txt'), 'cap');
    fs.writeFileSync(path.join(dir, 'a_002.png'), PNG_1PX); // no caption
    fs.writeFileSync(path.join(dir, 'a_003.txt'), 'cap');    // no image
    const info = readDataset('a', dir);
    assert.equal(info.images, 2);
    assert.equal(info.captions, 2);
    assert.equal(info.uncaptioned, 1);
    assert.equal(info.orphanCaptions, 1);
    assert.equal(info.ready, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readDataset reports not ready when no image has a caption', () => {
  const dir = tmpRoot();
  try {
    fs.writeFileSync(path.join(dir, 'a_001.png'), PNG_1PX);
    assert.equal(readDataset('a', dir).ready, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listDatasets finds every dataset folder and ignores the rest', () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, 'one', 'dataset'), { recursive: true });
    fs.writeFileSync(path.join(root, 'one', 'dataset', 'one_001.png'), PNG_1PX);
    fs.mkdirSync(path.join(root, 'two', 'dataset'), { recursive: true });
    fs.mkdirSync(path.join(root, 'not-a-run'), { recursive: true });
    const found = listDatasets(root);
    assert.deepEqual(found.map(d => d.triggerToken), ['one', 'two']);
    assert.equal(found[0].images, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listDatasets on a missing root is empty, not a throw', () => {
  assert.deepEqual(listDatasets(path.join(os.tmpdir(), 'does-not-exist-' + Date.now())), []);
});

// ---------------------------------------------------------------------------
// Starter dataset
// ---------------------------------------------------------------------------

test('the starter seed writes 4 captions and never overwrites an edit', () => {
  const root = tmpRoot();
  try {
    const first = seedDataset(root);
    assert.equal(first.written.length, 4);
    assert.equal(STARTER_CAPTIONS.length, 4);
    const file = path.join(root, TRIGGER, 'dataset', `${TRIGGER}_001.txt`);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), STARTER_CAPTIONS[0]);
    assert.ok(fs.readFileSync(file, 'utf8').startsWith('direk_scifi_neon, '));

    fs.writeFileSync(file, 'edited by hand\n');
    const second = seedDataset(root);
    assert.equal(second.written.length, 0, 'nothing may be rewritten');
    assert.equal(fs.readFileSync(file, 'utf8'), 'edited by hand\n', 'a hand edit must survive');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the seed writes no images, because a blank image would train nothing', () => {
  const root = tmpRoot();
  try {
    seedDataset(root);
    const files = fs.readdirSync(path.join(root, TRIGGER, 'dataset'));
    assert.equal(files.filter(f => /\.(png|jpe?g|webp)$/i.test(f)).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function fakeExtension(overrides: Partial<MovieCreatorExtension> = {}): MovieCreatorExtension {
  return {
    id: 'test-ext',
    name: 'Test',
    season: 9,
    version: '1.0.0',
    enabled: true,
    registerRoutes: () => {},
    skills: [{ id: 'test_skill', does: 'test', args: '{}', run: async () => ({ ran: true }) }],
    ...overrides,
  };
}

test('the registry mounts an extension and runs its skill', async () => {
  const registry = new ExtensionRegistry();
  registry.register(fakeExtension());
  const status = registry.mountExtensions({ get: () => {}, post: () => {} });
  assert.equal(status[0].state, 'mounted');
  assert.equal(registry.hasSkill('test_skill'), true);
  assert.deepEqual(await registry.runExtensionSkill('test_skill'), { ran: true });
});

test('a broken extension fails alone and the app still mounts the rest', () => {
  const registry = new ExtensionRegistry();
  registry.register(fakeExtension({ id: 'broken', registerRoutes: () => { throw new Error('kaboom'); } }));
  registry.register(fakeExtension({
    id: 'healthy',
    skills: [{ id: 'healthy_skill', does: 'x', args: '{}', run: async () => 1 }],
  }));
  const status = registry.mountExtensions({ get: () => {}, post: () => {} });
  const broken = status.find(s => s.id === 'broken')!;
  assert.equal(broken.state, 'failed');
  assert.match(broken.error!, /kaboom/);
  assert.equal(status.find(s => s.id === 'healthy')!.state, 'mounted');
  assert.equal(registry.hasSkill('healthy_skill'), true);
});

test('a failed extension exposes none of its skills', async () => {
  const registry = new ExtensionRegistry();
  registry.register(fakeExtension({ registerRoutes: () => { throw new Error('nope'); } }));
  registry.mountExtensions({ get: () => {}, post: () => {} });
  assert.equal(registry.hasSkill('test_skill'), false);
  await assert.rejects(() => registry.runExtensionSkill('test_skill'), /Naka-off/);
});

test('a disabled extension never mounts and its skill is refused', async () => {
  const registry = new ExtensionRegistry();
  registry.register(fakeExtension({ enabled: false }));
  const status = registry.mountExtensions({ get: () => {}, post: () => {} });
  assert.equal(status[0].state, 'disabled');
  await assert.rejects(() => registry.runExtensionSkill('test_skill'), /Naka-off/);
});

test('an unknown skill is refused with a clear message', async () => {
  const registry = new ExtensionRegistry();
  registry.mountExtensions({ get: () => {}, post: () => {} });
  await assert.rejects(() => registry.runExtensionSkill('wala'), /Walang skill/);
});

test('a duplicate extension id is rejected', () => {
  const registry = new ExtensionRegistry();
  registry.register(fakeExtension());
  assert.throws(() => registry.register(fakeExtension()), /May extension nang/);
});

test('an HTML error page served with 200 is rejected, not saved as an image', async () => {
  const dir = tmpRoot();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (u.pathname.startsWith('/img')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Not found</body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [{ path: `http://${req.headers.host}/img/gone.png`, dimension_x: 1920, dimension_y: 1080 }],
    }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  try {
    const result = await harvestImagesForLora({
      query: 'neon',
      triggerToken: 'test_tok',
      count: 1,
      targetDir: dir,
      endpoints: {
        wallhaven: `http://127.0.0.1:${port}/w`,
        openverse: `http://127.0.0.1:${port}/none`,
        wikimedia: `http://127.0.0.1:${port}/none2`,
      },
    });
    assert.equal(result.saved, 0);
    assert.ok(result.failures.some(f => /not an image/.test(f.reason)), JSON.stringify(result.failures));
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.png')).length, 0);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
