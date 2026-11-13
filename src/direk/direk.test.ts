import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGenre, catalogTerms } from './genres.ts';
import { missingFields, gateQuestion } from './gate.ts';
import { extractAction } from './skills.ts';
import { buildSystemPrompt } from './persona.ts';
import { ReferenceCatalog } from './reference.ts';
import { DirekService, type ChatMessage } from './service.ts';

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const catalog = new ReferenceCatalog(path.join(repoRoot, 'data'));

test('findGenre detects Tagalog and English genre words', () => {
  assert.equal(findGenre('Gusto ko ng horror na kwento'), 'horror');
  assert.equal(findGenre('katatakutan sa probinsya'), 'horror');
  assert.equal(findGenre('romance na pelikula'), 'romantic');
  assert.equal(findGenre('love story'), 'romantic');
  assert.equal(findGenre('walang genre dito'), null);
});

test('catalogTerms maps spoken genres to catalog section names', () => {
  assert.deepEqual(catalogTerms('comedy'), ['comedies', 'comedy']);
  assert.deepEqual(catalogTerms('romantic'), ['romantic', 'romance']);
  assert.equal(catalogTerms(null), null);
});

test('the mood gate no longer accepts genre words as mood (original bug)', () => {
  // "comedy" is a genre, not a mood, so mood must still be missing.
  assert.deepEqual(missingFields('Gumawa ka ng comedy, 3 minuto'), ['mood']);
  assert.deepEqual(missingFields('Gumawa ka ng horror, 3 minuto'), ['mood']);
  // A real mood word satisfies it.
  assert.deepEqual(missingFields('Gumawa ka ng comedy, 3 minuto, masaya'), []);
  // Duration still required.
  assert.deepEqual(missingFields('masaya lang'), ['haba']);
});

test('gateQuestion asks for the first missing essential, or null when complete', () => {
  assert.match(gateQuestion('horror, masaya')!, /gaano katagal/);
  assert.match(gateQuestion('horror, 3 minuto')!, /Anong mood/);
  assert.equal(gateQuestion('horror, 3 minuto, masaya'), null);
});

test('extractAction separates local and API skills', () => {
  const local = extractAction('Eto ang script.\n```action\n{"skill":"write_script"}\n```');
  assert.equal(local[0], 'Eto ang script.');
  assert.equal(local[1], null);
  assert.equal(local[2], null);

  const api = extractAction('Sige.\n```action\n{"skill":"publish_post","args":{"platform":"yt"}}\n```');
  assert.equal(api[1]?.skill, 'publish_post');
  assert.equal(api[1]?.needs_confirm, true);
  assert.equal(api[1]?.status, 'needs_confirm');

  const bad = extractAction('```action\nnot json\n```');
  assert.match(bad[2]!, /Sira ang format/);
});

test('buildSystemPrompt appends references only when both are present', () => {
  assert.equal(buildSystemPrompt().includes('REFERENSYA'), false);
  assert.equal(buildSystemPrompt([], 'horror').includes('REFERENSYA'), false);
  const prompt = buildSystemPrompt([{ title: 'Jaws 2', release_year: 1978, listed_in: 'Horror' }], 'horror');
  assert.match(prompt, /Jaws 2/);
  assert.match(prompt, /REFERENSYA/);
});

test('the catalog loads the bundled datasets and searches by genre', () => {
  assert.equal(catalog.available, true);
  assert.ok(catalog.size > 1000, `expected >1000 titles, got ${catalog.size}`);
  const horror = catalog.search('horror', 'Movie', 3);
  assert.ok(horror.length > 0);
  assert.ok(horror.every(h => h.listed_in.toLowerCase().includes('horror')));
  assert.deepEqual(catalog.search(null), []);
});

test('the catalog loads all four sources, including the statistics dataset', () => {
  const sources = catalog.sources();
  for (const name of ['Netflix', 'IMDb', 'Filipino', 'Statistics']) {
    assert.ok((sources[name] ?? 0) > 0, `expected rows for ${name}, got ${sources[name]}`);
  }
});

test('search draws round-robin across sources so none is crowded out', () => {
  const results = catalog.search('action', null, 4);
  const distinct = new Set(results.map(r => r.source));
  assert.ok(distinct.size >= 2, `expected multiple sources, got ${[...distinct].join(', ')}`);
});

test('the statistics dataset carries real commercial figures', () => {
  const withFigures = catalog
    .search('action', null, 20)
    .filter(r => r.source === 'Statistics' && typeof r.rating === 'number');
  assert.ok(withFigures.length > 0, 'expected a statistics row with a rating');
  assert.ok(withFigures[0].budget !== undefined, 'expected a budget');
  assert.ok(withFigures[0].worldwide_gross !== undefined, 'expected a worldwide gross');
});

test('DirekService gates before calling the model', async () => {
  let called = false;
  const service = new DirekService(catalog, async () => {
    called = true;
    return 'nagawa';
  });

  const gated = await service.chat([{ role: 'user', content: 'horror sa probinsya' }]);
  assert.equal(gated.gate, 'haba');
  assert.equal(called, false, 'the model must not run while the gate is open');

  const full = await service.chat([
    { role: 'user', content: 'horror sa probinsya, 3 minuto, nakakakaba' },
  ]);
  assert.equal(called, true);
  assert.equal(full.reply, 'nagawa');
  assert.equal(full.genre, 'horror');
  assert.ok(full.references.length > 0, 'a complete genre request carries references');
});
