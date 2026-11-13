import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScript, fallbackScript, sceneCount, scriptPrompt, moodPalette,
  wavFromPcm, parsePcmRate, wrapText, MOODS, MOOD_LABELS, TTS_VOICES,
} from './movie.ts';

test('parseScript reads a clean JSON screenplay', () => {
  const script = parseScript(JSON.stringify({
    title: 'Ang Dagat',
    logline: 'Isang mangingisda.',
    scenes: [
      { heading: 'SCENE 1 — DALAMPASIGAN, MADALING ARAW', narration: 'Maaga pa.', visual: 'wide shot', mood: 'warm' },
      { heading: 'SCENE 2', narration: 'Dumating ang bagyo.', visual: 'storm', mood: 'tense' },
    ],
  }));
  assert.ok(script);
  assert.equal(script!.title, 'Ang Dagat');
  assert.equal(script!.scenes.length, 2);
  assert.equal(script!.scenes[1].mood, 'tense');
});

test('parseScript tolerates fences and surrounding prose', () => {
  const raw = 'Narito ang screenplay:\n```json\n{"title":"X","logline":"Y","scenes":[{"heading":"A","narration":"Z","visual":"v","mood":"cold"}]}\n```\nSana makatulong.';
  const script = parseScript(raw);
  assert.ok(script);
  assert.equal(script!.title, 'X');
  assert.equal(script!.scenes[0].mood, 'cold');
});

test('parseScript rejects junk and drops scenes with no narration', () => {
  assert.equal(parseScript('walang json dito'), null);
  assert.equal(parseScript('{not valid json}'), null);
  const script = parseScript(JSON.stringify({
    title: 'T', logline: 'L',
    scenes: [{ heading: 'A', narration: '', visual: 'v', mood: 'warm' }, { heading: 'B', narration: 'may linya', visual: 'v', mood: 'grim' }],
  }));
  assert.equal(script!.scenes.length, 1);
  assert.equal(script!.scenes[0].heading, 'B');
});

test('parseScript falls back to a known mood when the model invents one', () => {
  const script = parseScript(JSON.stringify({
    title: 'T', logline: 'L',
    scenes: [{ heading: 'A', narration: 'linya', visual: 'v', mood: 'kadiri' }],
  }));
  assert.ok(MOODS.includes(script!.scenes[0].mood));
});

test('parseScript salvages a screenplay that was cut off mid-array', () => {
  const truncated =
    '{"title":"Ang Lihim ng Lambat","logline":"Isang mangingisda.","scenes":[' +
    '{"heading":"SCENE 1","narration":"Unang linya ng kuwento.","visual":"wide","mood":"grim"},' +
    '{"heading":"SCENE 2","narration":"Pangalawang linya.","visual":"close","mood":"tense"},' +
    '{"heading":"SCENE 3","narration":"Hindi pa tapos ang pangat';
  const script = parseScript(truncated);
  assert.ok(script, 'should salvage the finished scenes');
  assert.equal(script!.title, 'Ang Lihim ng Lambat');
  assert.equal(script!.scenes.length, 2);
  assert.equal(script!.scenes[1].mood, 'tense');
});

test('parseScript clips a narration that runs far too long', () => {
  const long = Array.from({ length: 200 }, (_, i) => `salita${i}`).join(' ');
  const script = parseScript(JSON.stringify({
    title: 'T', logline: 'L',
    scenes: [{ heading: 'A', narration: long, visual: 'v', mood: 'warm' }],
  }));
  const words = script!.scenes[0].narration.split(/\s+/).length;
  assert.ok(words <= 71, `expected a clipped line, got ${words} words`);
});

test('sceneCount grows with the length and stays in range', () => {
  assert.ok(sceneCount(1) >= 3);
  assert.ok(sceneCount(5) > sceneCount(1));
  assert.ok(sceneCount(60) <= 24);
});

test('fallbackScript needs no model and still fills every scene', () => {
  const script = fallbackScript('isang mangingisda sa probinsya', { minutes: 3 });
  assert.ok(script.scenes.length >= 3);
  for (const scene of script.scenes) {
    assert.ok(scene.narration.length > 0);
    assert.ok(scene.visual.length > 0);
    assert.ok(MOODS.includes(scene.mood));
  }
});

test('scriptPrompt asks for JSON and names the scene count', () => {
  const prompt = scriptPrompt('horror sa gubat', { minutes: 2 });
  assert.match(prompt, /JSON/);
  assert.match(prompt, new RegExp(String(sceneCount(2))));
  assert.match(prompt, /narration/);
});

test('moodPalette returns a usable base, amplitude and accent for every mood', () => {
  for (const mood of MOODS) {
    const p = moodPalette(mood);
    assert.equal(p.base.length, 3);
    assert.equal(p.amp.length, 3);
    assert.match(p.accent, /^0x[0-9a-f]{6}$/);
    for (const v of [...p.base, ...p.amp]) assert.ok(v >= 0 && v <= 255);
  }
});

test('every mood has a Tagalog label and every voice is listed', () => {
  for (const mood of MOODS) assert.ok(MOOD_LABELS[mood]);
  assert.ok(TTS_VOICES.includes('Kore'));
});

test('wavFromPcm writes a valid 16-bit mono WAV header', () => {
  const pcm = Buffer.alloc(1000, 7);
  const wav = wavFromPcm(pcm, 24000);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
});

test('parsePcmRate reads the rate and keeps a sane default', () => {
  assert.equal(parsePcmRate('audio/L16;codec=pcm;rate=24000'), 24000);
  assert.equal(parsePcmRate('audio/L16;codec=pcm;rate=48000'), 48000);
  assert.equal(parsePcmRate(undefined), 24000);
  assert.equal(parsePcmRate('audio/L16'), 24000);
});

test('wrapText keeps every caption line inside the frame width', () => {
  const line = 'Sa bawat paghampas ng alon sa pampang, tila may bumubulong na boses na hindi ko maintindihan.';
  const wrapped = wrapText(line, 40);
  const lines = wrapped.split('\n');
  assert.ok(lines.length > 1, 'a long line should wrap');
  for (const l of lines) assert.ok(l.length <= 40, `line too long: "${l}"`);
  assert.equal(lines.join(' '), line);
});

test('wrapText never returns more than four lines', () => {
  const long = Array.from({ length: 120 }, (_, i) => `salita${i}`).join(' ');
  assert.ok(wrapText(long, 20).split('\n').length <= 4);
});
