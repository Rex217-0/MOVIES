import test from 'node:test';
import assert from 'node:assert/strict';
import {
  marilagMovies, marilagConceptOptions, MARILAG_MOVIES, MARILAG_SCENES, MARILAG_SECONDS,
  MARILAG_TARGET_SCENES, MARILAG_TARGET_SECONDS,
} from './marilag.ts';
import { FEATURE_SCENES, FEATURE_SCENE_SECONDS, FEATURE_TOTAL_SECONDS } from '../featureFilm.ts';
import { MOODS } from '../movieMeta.ts';

test('the batch is exactly ten movies', () => {
  const movies = marilagMovies();
  assert.equal(movies.length, 10);
  assert.equal(MARILAG_MOVIES, 10);
  assert.deepEqual(movies.map(m => m.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('every Marilag movie is a distinct concept with a Tagalog title, genre and brief', () => {
  const movies = marilagMovies();
  const titles = new Set(movies.map(m => m.title));
  const briefs = new Set(movies.map(m => m.brief));
  assert.equal(titles.size, 10, 'titles are unique');
  assert.equal(briefs.size, 10, 'briefs are unique');
  for (const m of movies) {
    assert.ok(m.title.trim().length > 3, `${m.title} has a real title`);
    assert.ok(m.genre.trim().length > 2, `${m.title} has a genre`);
    assert.ok(m.brief.trim().length > 20, `${m.title} has a real brief`);
    assert.ok(MOODS.includes(m.mood), `${m.title} uses a known mood`);
  }
});

test('the genres are mixed, not one repeated genre', () => {
  const genres = new Set(marilagMovies().map(m => m.genre));
  assert.ok(genres.size >= 6, `expected a mix of genres, got ${genres.size}`);
});

test('the batch reports the engine\'s real scene count and length, not a hardcoded 12', () => {
  // The batch must advertise what the engine will actually produce.
  assert.equal(MARILAG_SCENES, FEATURE_SCENES);
  assert.equal(MARILAG_SECONDS, FEATURE_TOTAL_SECONDS);
  assert.equal(MARILAG_SCENES * FEATURE_SCENE_SECONDS, MARILAG_SECONDS);
});

test('the 60-minute target is stated and equals 12 scenes of five minutes', () => {
  assert.equal(MARILAG_TARGET_SCENES, 12);
  assert.equal(MARILAG_TARGET_SCENES * 300, MARILAG_TARGET_SECONDS);
  assert.equal(MARILAG_TARGET_SECONDS, 3600);
});

test('marilagConceptOptions carries the title, genre, brief and mood into the factory', () => {
  const first = marilagMovies()[0];
  const opts = marilagConceptOptions(first);
  assert.equal(opts.title, first.title);
  assert.equal(opts.genre, first.genre);
  assert.equal(opts.brief, first.brief);
  assert.equal(opts.mood, first.mood);
});
