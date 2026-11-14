import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { groundMovie, groundingBlock, topTropes, pacingFor } from './grounding.ts';
import { ReferenceCatalog } from './reference.ts';
import { MarketIntel } from './market.ts';

const dataDir = path.join(process.cwd(), 'data');
const catalog = new ReferenceCatalog(dataDir, 6);
const market = new MarketIntel(dataDir);

test('the reference catalog is loaded from the real CSVs', () => {
  assert.equal(catalog.available, true);
  assert.ok(catalog.size > 10000, `expected the full catalog, got ${catalog.size}`);
});

test('groundMovie pulls real reference titles for the brief genre', () => {
  const g = groundMovie('Isang horror sa masukal na gubat.', { minutes: 5, sceneCount: 11 }, catalog, market);
  assert.equal(g.genre, 'horror');
  assert.ok(g.references.length > 0, 'expected at least one reference title');
  // Every reference is a real catalog row.
  for (const ref of g.references) {
    assert.ok(ref.title.length > 0);
    assert.ok(ref.source.length > 0);
  }
});

test('groundMovie reads the box-office market stats', () => {
  const g = groundMovie('Isang romansa sa palengke.', { minutes: 3, sceneCount: 6 }, catalog, market);
  assert.equal(g.market_brief.length > 0, true);
  assert.match(g.market_brief, /genre/i);
});

test('topTropes ranks the most common genres across the references', () => {
  const tropes = topTropes([
    { title: 'A', type: 'Movie', listed_in: 'Horror, Thriller', release_year: '2001', duration: '90 min', source: 'IMDb' },
    { title: 'B', type: 'Movie', listed_in: 'Horror', release_year: '2002', duration: '90 min', source: 'IMDb' },
    { title: 'C', type: 'Movie', listed_in: 'Thriller, Drama', release_year: '2003', duration: '90 min', source: 'IMDb' },
  ]);
  assert.equal(tropes[0], 'Horror');
  assert.ok(tropes.includes('Thriller'));
});

test('pacingFor describes three acts of the requested length', () => {
  const line = pacingFor(5, 11);
  assert.match(line, /5 minuto/);
  assert.match(line, /11 eksena/);
  assert.match(line, /acto/);
});

test('groundingBlock renders a factual block, and is empty with no data', () => {
  const g = groundMovie('Isang horror sa gubat.', { minutes: 5, sceneCount: 11 }, catalog, market);
  const block = groundingBlock(g);
  assert.match(block, /DATOS NA GABAY/);
  assert.match(block, /reference/i);
  assert.match(block, /Pacing/);

  // With no catalog and no market, there is nothing to ground with but pacing.
  const bare = groundMovie('Walang genre na brief.', { minutes: 2, sceneCount: 4 });
  assert.equal(bare.references.length, 0);
  assert.equal(bare.market_brief, '');
});

test('scriptPrompt folds the grounding block in when it is given one', async () => {
  const { scriptPrompt } = await import('./movie.ts');
  const g = groundMovie('Isang horror sa gubat.', { minutes: 2, sceneCount: 4 }, catalog, market);
  const prompt = scriptPrompt('horror sa gubat', { minutes: 2 }, groundingBlock(g));
  assert.match(prompt, /DATOS NA GABAY/);
  assert.match(prompt, /JSON/);
});
