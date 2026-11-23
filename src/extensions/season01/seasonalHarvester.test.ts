/**
 * Real tests for the Bodegero and the seasonal harvester.
 *
 * Images are genuine PNGs generated once by ffmpeg at real sizes, served by a
 * real local HTTP server, and written to a real temp folder. Nothing is stubbed,
 * so the header parsing, the 720p gate, the quarantine move and the file
 * numbering all run exactly as they do in production.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MIN_DIMENSION,
  getPngDimensions,
  heuristicCaption,
  inspectImageWithBodegero,
  quarantineRejectedImage,
} from './bodegeroChecker.ts';
import {
  DEFAULT_GENRES,
  DEFAULT_PER_GENRE,
  DEFAULT_SCHEDULE,
  dueKey,
  isScheduleDue,
  loadSchedule,
  normalizeSchedule,
  queryForGenre,
  runSeasonalHarvest,
  saveSchedule,
  slugifyBatch,
  startScheduleTicker,
} from './seasonalHarvester.ts';
import { isValidTrigger } from '../../direk/lora.ts';

/** Build a valid PNG buffer of any size: IHDR is all the checker reads. */
function pngOf(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);            // chunk length
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;                          // bit depth
  ihdr[17] = 6;                          // colour type RGBA
  ihdr[18] = 0; ihdr[19] = 0; ihdr[20] = 0;  // compression, filter, interlace
  ihdr.writeUInt32BE(0, 21);             // CRC (not verified by the checker)
  return Buffer.concat([signature, ihdr]);
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'seasonal-'));
}

function writePng(dir: string, name: string, width: number, height: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, pngOf(width, height));
  return file;
}

interface Api {
  base: string;
  close: () => Promise<void>;
  searches: number;
  downloads: number;
}

/**
 * Serve the three real API shapes. `size` decides what resolution the served
 * images claim, which is how a test drives the 720p gate.
 */
function startApis(size: { width: number; height: number } = { width: 1280, height: 960 }): Promise<Api> {
  const state = { searches: 0, downloads: 0 };
  const body = pngOf(size.width, size.height);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/img')) {
      state.downloads += 1;
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(body);
      return;
    }
    state.searches += 1;
    const host = req.headers.host;
    const json = (payload: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/wallhaven') {
      json({
        data: Array.from({ length: 8 }, (_, i) => ({
          path: `http://${host}/img/wh-${i}.png`, dimension_x: size.width, dimension_y: size.height,
        })),
      });
      return;
    }
    if (url.pathname === '/openverse') {
      json({
        results: Array.from({ length: 8 }, (_, i) => ({
          url: `http://${host}/img/ov-${i}.png`, width: size.width, height: size.height,
        })),
      });
      return;
    }
    if (url.pathname === '/wikimedia') {
      const pages: Record<string, unknown> = {};
      for (let i = 0; i < 8; i += 1) {
        pages[String(i)] = { imageinfo: [{ url: `http://${host}/img/wm-${i}.png`, width: size.width, height: size.height }] };
      }
      json({ query: { pages } });
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
        get searches() { return state.searches; },
        get downloads() { return state.downloads; },
      });
    });
  });
}

function endpointsFor(api: Api) {
  return {
    wallhaven: `${api.base}/wallhaven`,
    openverse: `${api.base}/openverse`,
    wikimedia: `${api.base}/wikimedia`,
  };
}

// ---------------------------------------------------------------------------
// Bodegero: PNG header
// ---------------------------------------------------------------------------

test('getPngDimensions reads the IHDR of a real PNG', () => {
  assert.deepEqual(getPngDimensions(pngOf(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(getPngDimensions(pngOf(1, 1)), { width: 1, height: 1 });
});

test('getPngDimensions rejects a non-PNG, a truncated file and a bad first chunk', () => {
  assert.equal(getPngDimensions(Buffer.from('<html>nope</html>')), null);
  assert.equal(getPngDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);

  const wrongChunk = pngOf(800, 800);
  wrongChunk.write('XXXX', 12, 'latin1');
  assert.equal(getPngDimensions(wrongChunk), null);

  const zero = pngOf(0, 0);
  assert.equal(getPngDimensions(zero), null);
});

// ---------------------------------------------------------------------------
// Bodegero: the 720p gate
// ---------------------------------------------------------------------------

test('a 720p image is approved and gets a caption starting with the trigger', async () => {
  const dir = tmpRoot();
  try {
    const file = writePng(dir, 'a.png', 1280, 720);
    const decision = await inspectImageWithBodegero(file, 'direk_scifi_neon', 'horror', 'Christmas Eve concept');
    assert.equal(decision.passed, true);
    assert.match(decision.cleanCaption, /^direk_scifi_neon/);
    assert.equal(decision.width, 1280);
    assert.equal(decision.height, 720);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the short side must clear 720, so a wide banner is rejected', async () => {
  const dir = tmpRoot();
  try {
    // 2000x300 passes a width-only check and a naive `width < 720 && height < 720`.
    const file = writePng(dir, 'banner.png', 2000, 300);
    const decision = await inspectImageWithBodegero(file, 'tok', 'action', '');
    assert.equal(decision.passed, false);
    assert.match(decision.reason, /LOW_RES/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tall image is rejected for the same reason', async () => {
  const dir = tmpRoot();
  try {
    const file = writePng(dir, 'tall.png', 300, 2000);
    const decision = await inspectImageWithBodegero(file, 'tok', 'action', '');
    assert.equal(decision.passed, false);
    assert.match(decision.reason, /LOW_RES/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an extreme aspect ratio is rejected even when both sides are large', async () => {
  const dir = tmpRoot();
  try {
    const wide = writePng(dir, 'wide.png', 4000, 1000); // 4:1
    const wideDecision = await inspectImageWithBodegero(wide, 'tok', 'scifi', '');
    assert.equal(wideDecision.passed, false);
    assert.match(wideDecision.reason, /EXTREME_ASPECT/);

    const tall = writePng(dir, 'tall.png', 1000, 4000);
    const tallDecision = await inspectImageWithBodegero(tall, 'tok', 'scifi', '');
    assert.equal(tallDecision.passed, false);
    assert.match(tallDecision.reason, /EXTREME_ASPECT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt file is rejected with CORRUPT_NOT_PNG, not a crash', async () => {
  const dir = tmpRoot();
  try {
    const file = path.join(dir, 'broken.png');
    fs.writeFileSync(file, 'this is not a png at all');
    const decision = await inspectImageWithBodegero(file, 'tok', 'anime', '');
    assert.equal(decision.passed, false);
    assert.match(decision.reason, /CORRUPT_NOT_PNG/);
    assert.equal(decision.cleanCaption, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file is reported as unreadable, not thrown', async () => {
  const decision = await inspectImageWithBodegero('/tmp/definitely-not-here-12345.png', 'tok', 'anime', '');
  assert.equal(decision.passed, false);
  assert.match(decision.reason, /UNREADABLE/);
});

test('the offline caption is deterministic and carries genre and theme', () => {
  const caption = heuristicCaption('tok', 'horror', 'Araw ng Puso');
  assert.match(caption, /^tok, horror scene, Araw ng Puso/);
  assert.equal(caption, heuristicCaption('tok', 'horror', 'Araw ng Puso'));
  assert.equal(heuristicCaption('tok', 'horror', ''), 'tok, horror scene, ultra high definition, 4k, realistic cinematic lighting, sharp focus');
});

// ---------------------------------------------------------------------------
// Bodegero: quarantine
// ---------------------------------------------------------------------------

test('quarantine moves the file and writes the reason beside it', async () => {
  const root = tmpRoot();
  try {
    const staging = path.join(root, 'lora_staging', 'batch1');
    const file = writePng(staging, 'bad_001.png', 400, 400);
    const rejectedRoot = path.join(root, 'lora_rejected');

    const dest = await quarantineRejectedImage(file, 'batch1', 'LOW_RES: too small', rejectedRoot);
    assert.equal(fs.existsSync(file), false, 'the original must be gone from staging');
    assert.equal(fs.existsSync(dest), true);
    assert.equal(fs.readFileSync(`${dest}.reason.txt`, 'utf8'), 'LOW_RES: too small');
    assert.equal(path.basename(path.dirname(dest)), 'batch1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Seasonal harvester
// ---------------------------------------------------------------------------

test('a full sweep fills every genre and keeps rejects out of the dataset', async () => {
  const api = await startApis();
  const root = tmpRoot();
  try {
    const result = await runSeasonalHarvest({
      batchSlug: 'xmas-2026',
      theme: 'Christmas Eve concept',
      genres: ['horror', 'comedy'],
      perGenreCount: 3,
      triggerToken: 'direk_xmas',
      root,
      endpoints: endpointsFor(api),
    });

    assert.equal(result.approved, 6, JSON.stringify(result.perGenre));
    assert.equal(result.requested, 6);
    assert.equal(result.perGenre.length, 2);
    assert.ok(result.perGenre.every(g => g.complete));
    assert.equal(result.ok, true);

    const dataset = path.join(root, 'lora_runs', 'xmas_2026', 'dataset');
    const pngs = fs.readdirSync(dataset).filter(f => f.endsWith('.png'));
    const captions = fs.readdirSync(dataset).filter(f => f.endsWith('.txt'));
    assert.equal(pngs.length, 6);
    assert.equal(captions.length, 6, 'every image needs a caption');
    // The trainer finds a caption by swapping the extension, so `x.png.txt`
    // would silently leave the image untrained.
    for (const png of pngs) {
      assert.ok(
        captions.includes(png.replace(/\.png$/, '.txt')),
        `${png} walang katapat na .txt`,
      );
    }
    assert.equal(captions.filter(c => c.endsWith('.png.txt')).length, 0, 'dapat walang .png.txt');

    // Genre is part of the filename, so the two genres never collide.
    assert.ok(pngs.some(f => f.startsWith('xmas_2026_horror_')));
    assert.ok(pngs.some(f => f.startsWith('xmas_2026_comedy_')));

    for (const caption of captions) {
      const text = fs.readFileSync(path.join(dataset, caption), 'utf8');
      assert.match(text, /^direk_xmas/, `${caption} must start with the trigger`);
    }
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a sweep where every image is too small approves none and quarantines all', async () => {
  const api = await startApis({ width: 400, height: 300 });
  const root = tmpRoot();
  try {
    const result = await runSeasonalHarvest({
      batchSlug: 'tiny',
      genres: ['anime'],
      perGenreCount: 2,
      triggerToken: 'tok',
      root,
      endpoints: endpointsFor(api),
    });

    assert.equal(result.approved, 0);
    assert.equal(result.ok, false);
    assert.equal(result.perGenre[0].complete, false);
    assert.ok(result.rejected > 0, 'the rejects must be counted');

    const dataset = path.join(root, 'lora_runs', 'tiny', 'dataset');
    assert.equal(fs.readdirSync(dataset).filter(f => f.endsWith('.png')).length, 0);

    const rejected = path.join(root, 'lora_rejected', 'tiny');
    const reasons = fs.readdirSync(rejected).filter(f => f.endsWith('.reason.txt'));
    assert.ok(reasons.length > 0, 'every reject needs a reason file');
    const first = fs.readFileSync(path.join(rejected, reasons[0]), 'utf8');
    assert.match(first, /LOW_RES/);
    assert.match(result.note, /Walang na-approve/);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second sweep continues the numbering instead of overwriting', async () => {
  const api = await startApis();
  const root = tmpRoot();
  try {
    const options = {
      batchSlug: 'twice', genres: ['scifi'], perGenreCount: 2, triggerToken: 'tok',
      root, endpoints: endpointsFor(api),
    };
    const first = await runSeasonalHarvest(options);
    assert.equal(first.approved, 2);
    const second = await runSeasonalHarvest(options);
    assert.equal(second.approved, 2);

    const dataset = path.join(root, 'lora_runs', 'twice', 'dataset');
    const pngs = fs.readdirSync(dataset).filter(f => f.endsWith('.png')).sort();
    assert.deepEqual(pngs, [
      'twice_scifi_001.png', 'twice_scifi_002.png', 'twice_scifi_003.png', 'twice_scifi_004.png',
    ]);
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dead source does not stop the sweep', async () => {
  const api = await startApis();
  const root = tmpRoot();
  try {
    const endpoints = { ...endpointsFor(api), openverse: `${api.base}/gone` };
    const result = await runSeasonalHarvest({
      batchSlug: 'partial', genres: ['action'], perGenreCount: 2, triggerToken: 'tok',
      root, endpoints,
    });
    assert.equal(result.approved, 2, 'the healthy sources must still deliver');
  } finally {
    await api.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the default sweep is 8 genres at 10 each', () => {
  assert.equal(DEFAULT_GENRES.length, 8);
  assert.equal(DEFAULT_PER_GENRE, 10);
  assert.equal(DEFAULT_GENRES.length * DEFAULT_PER_GENRE, 80);
  assert.deepEqual([...DEFAULT_GENRES], [
    'horror', 'comedy', 'action', 'scifi', 'love_story', 'thriller', 'anime', 'cartoons',
  ]);
});

test('each genre maps to words a photo site actually indexes', () => {
  assert.match(queryForGenre('love_story', ''), /romantic couple/);
  assert.doesNotMatch(queryForGenre('love_story', ''), /love_story/, 'the token is not a search term');
  assert.equal(queryForGenre('horror', 'Christmas Eve concept'), 'dark horror cinematic Christmas Eve concept');
  assert.equal(queryForGenre('unknown_genre', ''), 'unknown genre');
});

test('a batch slug is made safe for a folder name', () => {
  assert.equal(slugifyBatch('Xmas 2026!!'), 'xmas_2026');
  assert.equal(slugifyBatch('  --Pasko--  '), 'pasko');
  assert.match(slugifyBatch(''), /^batch_\d{4}_\d{2}_\d{2}$/);
});

// The slug is reused as the LoRA trigger token, so it has to satisfy the real
// validator. The old hyphenated date default made every scheduled run fail.
test('every batch slug is a valid LoRA trigger token', () => {
  const inputs = ['', 'Xmas 2026!!', '  --Pasko--  ', '2026-11-23', '9lives', 'a', 'Araw ng Puso'];
  for (const input of inputs) {
    const slug = slugifyBatch(input);
    assert.ok(isValidTrigger(slug), `'${slug}' (mula sa '${input}') ay hindi valid trigger`);
  }
  assert.ok(isValidTrigger(slugifyBatch('')), 'the date default must be a valid trigger');
});

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

test('isScheduleDue matches the exact minute and honours wildcards', () => {
  const base = normalizeSchedule({ enabled: true, hour: 2, minute: 30 });
  const due = new Date(2026, 11, 24, 2, 30, 5);
  const early = new Date(2026, 11, 24, 2, 29, 59);

  assert.equal(isScheduleDue(base, due), true);
  assert.equal(isScheduleDue(base, early), false);

  const disabled = { ...base, enabled: false };
  assert.equal(isScheduleDue(disabled, due), false, 'a disabled schedule never fires');

  const sundayOnly = { ...base, dayOfWeek: 0 };
  assert.equal(isScheduleDue(sundayOnly, new Date(2026, 11, 27, 2, 30)), true);
  assert.equal(isScheduleDue(sundayOnly, new Date(2026, 11, 24, 2, 30)), false);

  const christmas = { ...base, month: 12, dayOfMonth: 25 };
  assert.equal(isScheduleDue(christmas, new Date(2026, 11, 25, 2, 30)), true);
  assert.equal(isScheduleDue(christmas, new Date(2026, 11, 24, 2, 30)), false);
  assert.equal(isScheduleDue(christmas, new Date(2027, 0, 25, 2, 30)), false);
});

test('dueKey is stable inside one minute and changes across minutes', () => {
  const a = dueKey(new Date(2026, 11, 24, 2, 30, 1));
  const b = dueKey(new Date(2026, 11, 24, 2, 30, 59));
  const c = dueKey(new Date(2026, 11, 24, 2, 31, 0));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('normalizeSchedule repairs a hand-edited file instead of throwing', () => {
  const fixed = normalizeSchedule({
    enabled: 'yes', hour: 99, minute: -5, dayOfWeek: 9, dayOfMonth: 40, month: 13,
    theme: '  Pasko  ', genres: ['horror', 'BAD GENRE', 'scifi'], perGenreCount: 999,
  });
  assert.equal(fixed.enabled, true);
  assert.equal(fixed.hour, DEFAULT_SCHEDULE.hour, 'out-of-range hour falls back');
  assert.equal(fixed.minute, DEFAULT_SCHEDULE.minute);
  assert.equal(fixed.dayOfWeek, null);
  assert.equal(fixed.dayOfMonth, null);
  assert.equal(fixed.month, null);
  assert.equal(fixed.theme, 'Pasko');
  assert.deepEqual(fixed.genres, ['horror', 'scifi']);
  assert.equal(fixed.perGenreCount, DEFAULT_PER_GENRE);
});

test('normalizeSchedule falls back to all 8 genres when none survive', () => {
  assert.equal(normalizeSchedule({ genres: ['!!', ''] }).genres.length, 8);
  assert.equal(normalizeSchedule({}).genres.length, 8);
});

test('a schedule round-trips through disk, and a broken file falls back', () => {
  const root = tmpRoot();
  try {
    const saved = saveSchedule({ ...DEFAULT_SCHEDULE, enabled: true, theme: 'Pasko', hour: 3 }, root);
    assert.equal(saved.hour, 3);
    assert.equal(fs.existsSync(path.join(root, 'harvest_schedule.json')), true);

    const loaded = loadSchedule(root);
    assert.equal(loaded.theme, 'Pasko');
    assert.equal(loaded.enabled, true);

    fs.writeFileSync(path.join(root, 'harvest_schedule.json'), '{ this is not json');
    const fallback = loadSchedule(root);
    assert.equal(fallback.enabled, false);
    assert.equal(fallback.genres.length, 8);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadSchedule returns defaults when no file exists', () => {
  const root = tmpRoot();
  try {
    const config = loadSchedule(root);
    assert.equal(config.enabled, false);
    assert.equal(config.genres.length, 8);
    assert.equal(config.perGenreCount, 10);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the ticker fires once per due minute and never re-fires in the same one', async () => {
  const root = tmpRoot();
  const fired: string[] = [];
  let clock = new Date(2026, 11, 24, 2, 30, 0);
  try {
    saveSchedule({ ...DEFAULT_SCHEDULE, enabled: true, hour: 2, minute: 30 }, root);
    const stop = startScheduleTicker(
      config => { fired.push(config.theme || 'no-theme'); },
      { cwd: root, intervalMs: 10, now: () => clock, log: () => {} },
    );

    await new Promise(r => setTimeout(r, 60));
    assert.equal(fired.length, 1, 'exactly one fire inside the due minute');

    clock = new Date(2026, 11, 24, 2, 31, 0);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(fired.length, 1, 'the next minute is not due');

    clock = new Date(2026, 11, 25, 2, 30, 0);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(fired.length, 2, 'the same time tomorrow fires again');

    stop();
    clock = new Date(2026, 11, 26, 2, 30, 0);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(fired.length, 2, 'a stopped ticker is silent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the ticker does not stack sweeps when one is still running', async () => {
  const root = tmpRoot();
  let started = 0;
  let release: () => void = () => {};
  const blocked = new Promise<void>(r => { release = r; });
  try {
    saveSchedule({ ...DEFAULT_SCHEDULE, enabled: true, hour: 2, minute: 30 }, root);
    const stop = startScheduleTicker(
      async () => { started += 1; await blocked; },
      { cwd: root, intervalMs: 10, now: () => new Date(2026, 11, 24, 2, 30, 0), log: () => {} },
    );
    await new Promise(r => setTimeout(r, 80));
    assert.equal(started, 1, 'a long sweep must not be started twice');
    release();
    stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
