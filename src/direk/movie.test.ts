import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseScript, fallbackScript, sceneCount, scriptPrompt, moodPalette,
  wavFromPcm, parsePcmRate, wrapText, renderFeatureScene,
  MOODS, MOOD_LABELS, TTS_VOICES,
} from './movie.ts';
import { probe } from './render.ts';

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

test('the offline Tagalog voice is on by default and names a Filipino model', async () => {
  const { tagalogVoice, narrationBackends } = await import('./movie.ts');
  assert.equal(tagalogVoice(), 'facebook/mms-tts-tgl');
  assert.equal(narrationBackends().tagalog, true);
});

test('the offline Tagalog voice can be turned off', async () => {
  const { tagalogVoice } = await import('./movie.ts');
  const before = process.env.TTS_TAGALOG_DISABLE;
  process.env.TTS_TAGALOG_DISABLE = '1';
  try {
    assert.equal(tagalogVoice(), null);
  } finally {
    if (before === undefined) delete process.env.TTS_TAGALOG_DISABLE;
    else process.env.TTS_TAGALOG_DISABLE = before;
  }
});

test('Fish Audio is only offered when a key is present', async () => {
  const { fishConfigured, narrationBackends } = await import('./movie.ts');
  const before = process.env.FISH_AUDIO_API_KEY;
  delete process.env.FISH_AUDIO_API_KEY;
  try {
    assert.equal(fishConfigured(), false);
    assert.equal(narrationBackends().fish, false);
  } finally {
    if (before !== undefined) process.env.FISH_AUDIO_API_KEY = before;
  }
});

// ---------------------------------------------------------------------------
// Narration fallback chain
// ---------------------------------------------------------------------------

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('narrationOrder defaults to Fish, Tagalog, Gemini, then Piper', async () => {
  const { narrationOrder } = await import('./movie.ts');
  await withEnv({ TTS_ORDER: undefined }, () => {
    assert.deepEqual(narrationOrder(), ['fish', 'tagalog', 'gemini', 'piper']);
  });
});

test('TTS_ORDER overrides the chain and drops unknown voices', async () => {
  const { narrationOrder } = await import('./movie.ts');
  await withEnv({ TTS_ORDER: 'fish,piper,captions,bogus' }, () => {
    assert.deepEqual(narrationOrder(), ['fish', 'piper']);
  });
  // A TTS_ORDER that names nothing usable falls back to the default chain.
  await withEnv({ TTS_ORDER: 'nonsense' }, () => {
    assert.deepEqual(narrationOrder(), ['fish', 'tagalog', 'gemini', 'piper']);
  });
});

test('voiceReady reports a voice as usable only when it is configured', async () => {
  const { voiceReady } = await import('./movie.ts');
  await withEnv({ FISH_AUDIO_API_KEY: undefined, TTS_TAGALOG_DISABLE: '1' }, () => {
    assert.equal(voiceReady('fish'), false);
    assert.equal(voiceReady('tagalog'), false);
    assert.equal(voiceReady('piper'), false);
  });
  await withEnv({ FISH_AUDIO_API_KEY: 'test-key' }, () => {
    assert.equal(voiceReady('fish'), true);
  });
  await withEnv({ FISH_AUDIO_API_KEY: undefined, TTS_TAGALOG_DISABLE: undefined }, () => {
    // The offline Tagalog voice is on by default (the script ships with the app).
    assert.equal(voiceReady('tagalog'), true);
  });
});

test('narrationBackendOrder lists only the ready voices, in order', async () => {
  const { narrationBackendOrder } = await import('./movie.ts');
  await withEnv(
    { FISH_AUDIO_API_KEY: undefined, TTS_TAGALOG_DISABLE: '1', TTS_PIPER_VOICE: undefined, GEMINI_API_KEY: undefined },
    () => {
      assert.deepEqual(narrationBackendOrder(), [], 'nothing ready means captions');
    },
  );
  await withEnv({ FISH_AUDIO_API_KEY: 'k', TTS_TAGALOG_DISABLE: undefined }, () => {
    const order = narrationBackendOrder();
    assert.equal(order[0], 'fish', 'Fish is first when a key is present');
    assert.ok(order.includes('tagalog'));
  });
});

test('narrationBackends exposes the chain for the status endpoint', async () => {
  const { narrationBackends } = await import('./movie.ts');
  const backends = narrationBackends();
  assert.ok(Array.isArray(backends.order));
  assert.deepEqual(backends.order, (await import('./movie.ts')).narrationBackendOrder());
});


test('renderFeatureScene makes one standalone clip at the scene length', async () => {
  // The unit of the factory: a single five-minute scene, rendered alone, at a
  // fixed size/rate so it can later be joined with `ffmpeg -c copy`.
  const scene = { heading: 'SCENE 7', narration: 'Isang pagsubok ng eksena.', visual: 'wide shot', mood: 'tense' as const };
  const result = await renderFeatureScene(scene, { index: 7, seconds: 4 });
  assert.equal(result.seconds, 4);
  assert.equal(typeof result.voiced, 'boolean');
  assert.ok(result.data.length > 1000, 'a real MP4 came back');

  const file = path.join(os.tmpdir(), `feature-scene-${process.pid}.mp4`);
  fs.writeFileSync(file, result.data);
  const info = await probe(file);
  assert.equal(info.width, 1280);
  assert.equal(info.height, 720);
  assert.equal(info.hasAudio, true, 'every scene carries an audio track');
  assert.ok(Math.abs(info.duration - 4) < 0.4, `expected ~4s, got ${info.duration}`);
  fs.rmSync(file, { force: true });
});
