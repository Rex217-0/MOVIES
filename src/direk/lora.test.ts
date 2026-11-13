import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip, listZipEntries, crc32 } from './zip.ts';
import {
  toSlug, isValidTrigger, buildCaption, buildLoraArtifacts, buildLoraZip,
  type LoraBrief,
} from './lora.ts';
import { planLora, shotsForDuration } from './loraPlan.ts';
import { ReferenceCatalog } from './reference.ts';
import { MarketIntel } from './market.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test('crc32 matches the known check value for "123456789"', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('createZip writes a readable archive with all entries', () => {
  const zip = createZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'nested/b.txt', data: Buffer.from('world') },
  ]);
  assert.deepEqual(listZipEntries(zip), ['a.txt', 'nested/b.txt']);
});

test('toSlug produces safe file names and isValidTrigger enforces the token shape', () => {
  assert.equal(toSlug('Ang Huling Tala!'), 'ang_huling_tala');
  assert.equal(isValidTrigger('direk_ang_huling_tala'), true);
  assert.equal(isValidTrigger('Direk'), false);
  assert.equal(isValidTrigger('ab'), false);
  assert.equal(isValidTrigger('has space'), false);
});

test('buildCaption puts the trigger token first, then the character look', () => {
  const brief: LoraBrief = {
    title: 'T',
    genre: 'horror',
    mood: 'madilim',
    trigger: 'direk_t',
    character: { name: 'Bida', look: 'mahabang buhok', wardrobe: 'pula' },
    samples: [],
  };
  const caption = buildCaption(brief, { slug: 's', stage: 'VISUAL', prompt: 'gabi sa gubat' });
  assert.ok(caption.startsWith('direk_t'));
  assert.match(caption, /mahabang buhok/);
  assert.match(caption, /suot pula/);
  assert.match(caption, /gabi sa gubat/);
});

test('buildLoraArtifacts emits one caption per sample plus config files', () => {
  const brief: LoraBrief = {
    title: 'Ang Huling Tala',
    genre: 'drama',
    mood: 'mabigat',
    trigger: 'direk_ang_huling_tala',
    character: { name: 'Bida' },
    samples: [
      { slug: 'shot_001', stage: 'KARAKTER', prompt: 'portrait' },
      { slug: 'shot_002', stage: 'SHOT_LIST', prompt: 'wide shot' },
    ],
  };
  const names = buildLoraArtifacts(brief).map(a => a.filename);
  assert.ok(names.includes('dataset/direk_ang_huling_tala_001.txt'));
  assert.ok(names.includes('dataset/direk_ang_huling_tala_002.prompt.json'));
  assert.ok(names.includes('kohya_config.toml'));
  assert.ok(names.includes('dataset_info.json'));
  assert.ok(names.includes('dataset/README.md'));
});

test('buildLoraArtifacts rejects a bad trigger or an empty set', () => {
  const base: LoraBrief = {
    title: 'T', genre: 'drama', mood: 'mabigat', trigger: 'Bad Token',
    character: { name: 'Bida' },
    samples: [{ slug: 's', stage: 'VISUAL', prompt: 'x' }],
  };
  assert.throws(() => buildLoraArtifacts(base), /Invalid trigger/);
  assert.throws(
    () => buildLoraArtifacts({ ...base, trigger: 'direk_ok', samples: [] }),
    /at least one sample/,
  );
});

test('buildLoraZip packages every artifact', () => {
  const brief: LoraBrief = {
    title: 'T', genre: 'horror', mood: 'madilim', trigger: 'direk_t',
    character: { name: 'Bida' },
    samples: [{ slug: 'shot_001', stage: 'VISUAL', prompt: 'x' }],
  };
  const names = listZipEntries(buildLoraZip(brief, { when: new Date('2026-01-01T00:00:00Z') }));
  assert.ok(names.includes('kohya_config.toml'));
  assert.ok(names.includes('dataset/direk_t_001.txt'));
});

test('buildLoraZip bundles generated PNGs and an IMAGES.md manifest', () => {
  const brief: LoraBrief = {
    title: 'Ang Huling Tala', genre: 'horror', mood: 'madilim',
    trigger: 'direk_ang_huling_tala',
    character: { name: 'Bida' },
    samples: [
      { slug: 'shot_001', stage: 'KARAKTER', prompt: 'portrait' },
      { slug: 'shot_002', stage: 'SHOT_LIST', prompt: 'wide' },
    ],
  };
  // A tiny stand-in for a PNG; the builder never inspects the bytes.
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const images = new Map([['direk_ang_huling_tala_001', fakePng]]);
  const names = listZipEntries(
    buildLoraZip(brief, { images, skipped: ['direk_ang_huling_tala_002'] }),
  );
  assert.ok(names.includes('dataset/direk_ang_huling_tala_001.png'));
  assert.ok(!names.includes('dataset/direk_ang_huling_tala_002.png'));
  assert.ok(names.includes('dataset/IMAGES.md'));
  assert.ok(names.includes('dataset/direk_ang_huling_tala_001.txt'));
});

test('buildLoraZip records a note when no images are produced', () => {
  const brief: LoraBrief = {
    title: 'T', genre: 'drama', mood: 'mabigat', trigger: 'direk_t',
    character: { name: 'Bida' },
    samples: [{ slug: 'shot_001', stage: 'VISUAL', prompt: 'x' }],
  };
  const zip = buildLoraZip(brief, { imageNote: 'Text-only: no image model.' });
  assert.ok(listZipEntries(zip).includes('dataset/IMAGES.md'));
});

test('shotsForDuration scales with runtime and stays in a trainable range', () => {
  assert.equal(shotsForDuration(undefined), 12);
  assert.equal(shotsForDuration(3), 6);
  assert.equal(shotsForDuration(10), 20);
  assert.equal(shotsForDuration(120), 40);
});

test('planLora is deterministic, reuses the catalog, and grounds the prompt', () => {
  const catalog = new ReferenceCatalog(path.join(repoRoot, 'data'));
  const market = new MarketIntel(path.join(repoRoot, 'data'));
  const plan = planLora(
    { title: 'Ang Huling Tala', genre: 'horror', mood: 'madilim', durationMinutes: 5 },
    catalog,
    market,
  );
  assert.equal(plan.brief.trigger, 'direk_ang_huling_tala');
  assert.equal(plan.brief.samples.length, 10);
  assert.ok(plan.references.length > 0, 'expected catalog references');
  assert.ok(plan.brief.marketNote && plan.brief.marketNote.includes('Market share'));
  for (const sample of plan.brief.samples) {
    assert.match(sample.prompt, /cinematic lighting/);
    assert.match(sample.prompt, /madilim/);
  }
  // Same input -> same plan.
  const again = planLora(
    { title: 'Ang Huling Tala', genre: 'horror', mood: 'madilim', durationMinutes: 5 },
    catalog,
    market,
  );
  assert.deepEqual(again.brief.samples, plan.brief.samples);
});
