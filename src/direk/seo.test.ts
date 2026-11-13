import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeoPack } from './seo.ts';

test('buildSeoPack returns titles, description, tags and hashtags', () => {
  const pack = buildSeoPack('Alat ng Dagat', {
    logline: 'Isang mangingisdang lumalaban sa bagyo.',
    keywords: ['drama', 'mangingisda'],
    mood: 'mabigat',
  });
  assert.ok(pack.titles.length >= 2);
  assert.equal(pack.titles[0], 'Alat ng Dagat');
  assert.match(pack.description, /mangingisdang lumalaban/);
  assert.ok(pack.tags.includes('drama'));
  assert.ok(pack.hashtags.some(h => h === '#Drama'));
  assert.ok(pack.hashtags.every(h => h.startsWith('#')));
});

test('chapters only appear when a duration is known, and stay ordered', () => {
  const none = buildSeoPack('Walang Haba');
  assert.equal(none.chapters.length, 0);

  const withDuration = buildSeoPack('May Haba', { durationSeconds: 180 });
  assert.equal(withDuration.chapters.length, 4);
  assert.equal(withDuration.chapters[0].at, '00:00');
  assert.equal(withDuration.chapters[1].at, '00:45');
  assert.equal(withDuration.chapters[2].at, '01:48');
});

test('thumbnailText is short and upper case', () => {
  const pack = buildSeoPack('Isang Napakahabang Pamagat Ng Pelikula Tungkol Sa Dagat');
  assert.equal(pack.thumbnailText, pack.thumbnailText.toUpperCase());
  assert.ok(pack.thumbnailText.length <= 30);
});

test('hashtags strip accents and punctuation', () => {
  const pack = buildSeoPack('Pélicula: Sarado!', { keywords: ['mangingisda-buhay'] });
  assert.ok(pack.hashtags.every(h => /^#[A-Za-z0-9]+$/.test(h)));
});
