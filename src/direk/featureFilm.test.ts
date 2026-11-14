import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConcept, buildScenes, deriveTitle, guessGenre, guessRating, guessFormat,
  beatFor, breakdownPrompt, parseBreakdown, mergeScenes,
} from './featureFilm.ts';
import {
  FEATURE_SCENES, FEATURE_SCENE_SECONDS, FEATURE_TOTAL_SECONDS, actOf, filmClock,
} from '../featureFilm.ts';

test('the film is 18 scenes of exactly five minutes, 90 minutes total', () => {
  assert.equal(FEATURE_SCENES, 18);
  assert.equal(FEATURE_SCENE_SECONDS, 300);
  assert.equal(FEATURE_TOTAL_SECONDS, 5400);
  assert.equal(filmClock(FEATURE_TOTAL_SECONDS), '1:30:00');
});

test('actOf splits 18 scenes into three acts of six', () => {
  assert.equal(actOf(1), 1);
  assert.equal(actOf(6), 1);
  assert.equal(actOf(7), 2);
  assert.equal(actOf(12), 2);
  assert.equal(actOf(13), 3);
  assert.equal(actOf(18), 3);
});

test('buildConcept derives every field from one sentence', () => {
  const concept = buildConcept({ brief: 'Horror sa masukal na gubat: may sumusunod sa mga bisita.' });
  assert.equal(concept.genre, 'horror');
  assert.equal(concept.rating, 'SPG');
  assert.equal(concept.format, 'Realistic');
  assert.ok(concept.title.length > 0);
  assert.equal(concept.brief, 'Horror sa masukal na gubat: may sumusunod sa mga bisita.');
});

test('explicit concept fields win over the guesses', () => {
  const concept = buildConcept({
    brief: 'Isang kuwento ng pag-ibig sa Mars.',
    title: 'Ang Pulang Planeta',
    genre: 'sci-fi',
    rating: 'G',
    format: 'Animated',
  });
  assert.equal(concept.title, 'Ang Pulang Planeta');
  assert.equal(concept.genre, 'sci-fi');
  assert.equal(concept.rating, 'G');
  assert.equal(concept.format, 'Animated');
});

test('genre, rating and format guesses follow the words in the brief', () => {
  assert.equal(guessGenre('isang nakakakaba at madilim na kuwento'), 'horror');
  assert.equal(guessGenre('pag-ibig sa palengke'), 'romantic');
  assert.equal(guessGenre('walang sinasabing genre'), 'drama');
  assert.equal(guessRating('kwento ng pamilya at mga bata'), 'G');
  assert.equal(guessRating('madugo at maraming patay'), 'R');
  assert.equal(guessRating('isang karaniwang araw'), 'PG');
  assert.equal(guessFormat('isang anime na kuwento'), 'Animated');
  assert.equal(guessFormat('totoong tao ang mga tauhan'), 'Realistic');
});

test('deriveTitle skips filler words and title-cases what is left', () => {
  const title = deriveTitle('ang lihim ng mangingisda sa probinsya');
  assert.ok(/Lihim/.test(title), title);
  assert.ok(/Mangingisda/.test(title), title);
  assert.equal(deriveTitle(''), 'Isang Pelikula');
});

test('buildScenes always returns 18 five-minute scenes with three acts', () => {
  const concept = buildConcept({ brief: 'Isang aksyon sa Maynila.' });
  const scenes = buildScenes(concept);
  assert.equal(scenes.length, 18);
  assert.equal(scenes[0].index, 1);
  assert.equal(scenes[17].index, 18);
  for (const scene of scenes) {
    assert.equal(scene.seconds, 300);
    assert.ok(scene.heading.includes(`SCENE ${scene.index}`));
    assert.ok(scene.narration.length > 0);
    assert.ok(scene.visual.length > 0);
    assert.ok(['warm', 'cold', 'tense', 'dreamy', 'grim', 'hopeful'].includes(scene.mood));
  }
  assert.equal(new Set(scenes.map(s => s.act)).size, 3);
});

test('every scene index has its own beat, start to finish', () => {
  const first = beatFor(1);
  const last = beatFor(18);
  assert.ok(/Pagbubukas/.test(first));
  assert.ok(/Pagwawakas/.test(last));
  assert.notEqual(first, last);
});

test('the breakdown prompt asks for exactly 18 scenes', () => {
  const concept = buildConcept({ brief: 'Isang sci-fi sa Mars.' });
  const prompt = breakdownPrompt(concept);
  assert.ok(prompt.includes('18'));
  assert.ok(prompt.includes('5 minuto'));
  assert.ok(prompt.includes(concept.title));
});

test('parseBreakdown reads a fenced JSON reply and salvages a truncated one', () => {
  const good = parseBreakdown('```json\n{"scenes":[{"narration":"a"},{"narration":"b"},{"narration":"c"}]}\n```');
  assert.ok(good && Array.isArray((good as any).scenes));
  assert.equal((good as any).scenes.length, 3);

  const truncated = parseBreakdown(
    '{"scenes":[{"narration":"isa","mood":"warm"},{"narration":"dalawa","mood":"grim"},{"narration":"tatlo","mood":"cold"},{"narration":"apa',
  );
  assert.ok(truncated && (truncated as any).scenes.length >= 3);

  assert.equal(parseBreakdown('wala itong json'), null);
});

test('mergeScenes folds a model list onto the deterministic 18, keeping the length', () => {
  const concept = buildConcept({ brief: 'Isang horror sa gubat.' });
  const fallback = buildScenes(concept);
  const model = {
    scenes: [
      { heading: 'Sariling simula', narration: 'Isang gabing madilim.', visual: 'dark forest', mood: 'grim' },
      { heading: 'Sariling gitna', narration: 'May sumusunod.', visual: 'a shadow', mood: 'tense' },
      { heading: 'Sariling wakas', narration: 'Tumakbo siya.', visual: 'running', mood: 'cold' },
    ],
  };
  const merged = mergeScenes(model, fallback, concept);
  assert.equal(merged.length, 18);
  assert.equal(merged[0].heading, 'Sariling simula');
  assert.equal(merged[0].mood, 'grim');
  // Beyond the model's three scenes, the deterministic breakdown stands.
  assert.equal(merged[5].heading, fallback[5].heading);

  // A bad payload leaves the fallback untouched.
  assert.deepEqual(mergeScenes(null, fallback, concept), fallback);
  assert.deepEqual(mergeScenes({ scenes: [] }, fallback, concept), fallback);
});
