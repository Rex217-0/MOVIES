import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { genreOfStem, listDatasets, readDataset } from './datasets.ts';

/** A throwaway runs root holding one dataset folder, so nothing is mocked. */
function makeRunsRoot(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'datasets-test-'));
  const dir = path.join(root, 'batch1', 'dataset');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x');
  return root;
}

test('genreOfStem reads the genre the harvester writes into the stem', () => {
  assert.equal(genreOfStem('batch1_horror_001'), 'horror');
  assert.equal(genreOfStem('batch1_love_story_012'), 'love_story');
  assert.equal(genreOfStem('BATCH1_SCIFI_004'), 'scifi');
});

test('genreOfStem ignores a slug that merely contains a genre word', () => {
  // "horrorish" is not the horror genre, and a bare number has none at all.
  assert.equal(genreOfStem('horrorish_batch1_001'), null);
  assert.equal(genreOfStem('batch1_001'), null);
});

test('genreOfStem finds the genre when the slug itself has underscores', () => {
  assert.equal(genreOfStem('my_slug_batch1_anime_007'), 'anime');
});

test('genreOfStem anchors on the token before the index, not the first match', () => {
  // The batch slug is user text and may contain a genre word. The genre the
  // harvester wrote is the one sitting right before the index.
  assert.equal(genreOfStem('horror_special_comedy_001'), 'comedy');
  assert.equal(genreOfStem('my_anime_project_thriller_007'), 'thriller');
});

test('genreOfStem returns null when the genre is not right before the index', () => {
  // `direk_scifi_neon_001` is the shipped preset: "scifi" is part of the trigger
  // name, not a genre slot, so it must not be counted as scifi samples.
  assert.equal(genreOfStem('direk_scifi_neon_001'), null);
  assert.equal(genreOfStem('demo_horror_001_extra'), null);
});

test('readDataset counts only captioned images per genre', () => {
  const root = makeRunsRoot([
    'b_horror_001.png', 'b_horror_001.txt',
    'b_horror_002.png', 'b_horror_002.txt',
    'b_comedy_001.png', 'b_comedy_001.txt',
    // An uncaptioned image trains nothing, so it must not count in any genre.
    'b_comedy_002.png',
    // A caption without an image is reported separately.
    'b_anime_001.txt',
  ]);
  const info = readDataset('b', path.join(root, 'batch1', 'dataset'));

  assert.deepEqual(info.genres, { horror: 2, comedy: 1 });
  assert.equal(info.images, 4);
  assert.equal(info.captions, 4);
  assert.equal(info.uncaptioned, 1);
  assert.equal(info.orphanCaptions, 1);
  assert.equal(info.ready, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readDataset buckets filenames with no genre token as unclassified', () => {
  const root = makeRunsRoot(['batch1_001.png', 'batch1_001.txt']);
  const info = readDataset('batch1', path.join(root, 'batch1', 'dataset'));

  assert.deepEqual(info.genres, { unclassified: 1 });
  fs.rmSync(root, { recursive: true, force: true });
});

test('listDatasets reports genres for every dataset on disk', () => {
  const root = makeRunsRoot(['b_action_001.png', 'b_action_001.txt', 'b_action_002.png', 'b_action_002.txt']);
  const [dataset] = listDatasets(root);

  assert.equal(dataset.triggerToken, 'batch1');
  assert.deepEqual(dataset.genres, { action: 2 });
  fs.rmSync(root, { recursive: true, force: true });
});

test('listDatasets on a missing root is empty, not an error', () => {
  assert.deepEqual(listDatasets(path.join(os.tmpdir(), 'definitely-not-here-98231')), []);
});
