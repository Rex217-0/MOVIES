import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  generateScript, generateCharacterBible, breakdownScenes, pilotStatus, pilotReady,
  pilotUrl, pilotConfigured, generateScriptAnswer, writeScreenplay,
  PilotUnavailable, PILOT_UNAVAILABLE,
} from './pilotService.ts';

/**
 * A stand-in for the Kaggle Pilot: the real Cloudflare-tunnel endpoints, over a
 * real HTTP server, so the bridge is exercised for real instead of mocked.
 */
function startPilot(opts: { script?: string; bible?: string; scenes?: unknown[]; fail?: number } = {}) {
  const server = http.createServer((req, res) => {
    if (opts.fail) {
      res.statusCode = opts.fail;
      res.end('{"error":"boom"}');
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = (payload: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/health') return json({ ok: true });
      if (req.url === '/generate_script') return json({ script: opts.script ?? 'SCENE 1: ang simula.' });
      if (req.url === '/generate_character_bible') return json({ bible: opts.bible ?? 'Ramon — mangingisda, 40s.' });
      if (req.url === '/breakdown_scenes') {
        return json({ scenes: opts.scenes ?? [
          { heading: 'SCENE 1', narration: 'Narration isa.', visual: 'A wide shot', mood: 'warm' },
          { heading: 'SCENE 2', narration: 'Narration dalawa.', visual: 'A close-up', mood: 'tense' },
          { heading: 'SCENE 3', narration: 'Narration tatlo.', visual: 'A pan', mood: 'grim' },
        ] });
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise<{ url: string; close: () => Promise<void>; lastBody: () => any }>(resolve => {
    let last = '';
    server.on('request', req => { req.on('data', c => { last += c; }); });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
        lastBody: () => { try { return JSON.parse(last); } catch { return last; } },
      });
    });
  });
}

/** Run `fn` with the Pilot environment set, then restore it. */
async function withPilot<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const keys = [
    'KAGGLE_PILOT_URL', 'KAGGLE_PILOT_TOKEN', 'KAGGLE_PILOT_TIMEOUT_MS',
    'KAGGLE_PILOT_SCRIPT_PATH', 'KAGGLE_PILOT_BIBLE_PATH', 'KAGGLE_PILOT_SCENES_PATH',
    'LOCAL_OLLAMA_URL', 'OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_DISABLE',
    // Blank the paid providers so a developer's key cannot make these tests
    // depend on the network, or silently change which worker answers.
    'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY',
    'GEMINI_API_BASE', 'DEEPSEEK_API_BASE', 'ANTHROPIC_API_BASE', 'GEMINI_TEXT_MODELS',
    // Pollinations is keyless and always configured, so without this a test that
    // expects "every worker is down" would reach the real internet and pass or
    // fail depending on the weather.
    'POLLINATIONS_TEXT_DISABLE',
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    // Absent means "off" for every paid provider, but the free keyless one must
    // be explicitly disabled: leaving the flag unset would let it reach the real
    // internet during a test that expects every worker to be down.
    const fallback = k === 'POLLINATIONS_TEXT_DISABLE' ? '1' : undefined;
    const value = env[k] === undefined ? fallback : env[k];
    if (value === undefined) delete process.env[k];
    else process.env[k] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * A stand-in for the local Ollama instance (T1). It answers the two endpoints
 * the Pilot fallback uses: `/api/tags` for the status probe and `/api/chat` for
 * generation, over a real HTTP server.
 */
function startOllama(opts: { reply?: string } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = (payload: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/api/tags') return json({ models: [{ name: 'qwen2.5:7b' }] });
      if (req.url === '/api/chat') {
        return json({ message: { content: opts.reply ?? GATE_PASSING_SCRIPT } });
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise<{ url: string; close: () => Promise<void>; lastBody: () => any }>(resolve => {
    let last = '';
    server.on('request', req => { req.on('data', c => { last += c; }); });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
        lastBody: () => { try { return JSON.parse(last); } catch { return last; } },
      });
    });
  });
}

/** A URL on a closed port, so nothing answers there. */
async function deadUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  await new Promise<void>(r => server.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

test('pilotUrl trims trailing slashes and pilotConfigured reflects it', async () => {
  await withPilot({ KAGGLE_PILOT_URL: 'https://x.trycloudflare.com///' }, async () => {
    assert.equal(pilotUrl(), 'https://x.trycloudflare.com');
    assert.equal(pilotConfigured(), true);
  });
  await withPilot({ KAGGLE_PILOT_URL: '' }, async () => {
    assert.equal(pilotUrl(), '');
    assert.equal(pilotConfigured(), false);
  });
});

test('pilotStatus reports not-configured without a URL', async () => {
  await withPilot({ KAGGLE_PILOT_URL: '' }, async () => {
    const status = await pilotStatus();
    assert.equal(status.configured, false);
    assert.equal(status.reachable, false);
    assert.match(status.detail, /KAGGLE_PILOT_URL/);
  });
});

test('pilotStatus and pilotReady report an online worker', async () => {
  const pilot = await startPilot();
  try {
    await withPilot({ KAGGLE_PILOT_URL: pilot.url }, async () => {
      const status = await pilotStatus();
      assert.equal(status.configured, true);
      assert.equal(status.reachable, true);
      assert.equal(await pilotReady(), true);
    });
  } finally {
    await pilot.close();
  }
});

test('a dead tunnel reports unreachable instead of throwing', async () => {
  // A closed port: the worker is configured but not answering.
  const pilot = await startPilot();
  const url = pilot.url;
  await pilot.close();
  await withPilot({ KAGGLE_PILOT_URL: url }, async () => {
    const status = await pilotStatus();
    assert.equal(status.configured, true);
    assert.equal(status.reachable, false);
    assert.equal(await pilotReady(), false);
  });
});

test('generateScript POSTs the brief and returns the screenplay', async () => {
  const pilot = await startPilot({ script: 'ANG HULING TALA — screenplay.' });
  try {
    await withPilot({ KAGGLE_PILOT_URL: pilot.url }, async () => {
      const script = await generateScript('Isang mangingisda sa probinsya.');
      assert.equal(script, 'ANG HULING TALA — screenplay.');
      assert.equal(pilot.lastBody().brief, 'Isang mangingisda sa probinsya.');
    });
  } finally {
    await pilot.close();
  }
});

test('generateCharacterBible and breakdownScenes return the worker output', async () => {
  const pilot = await startPilot();
  try {
    await withPilot({ KAGGLE_PILOT_URL: pilot.url }, async () => {
      const bible = await generateCharacterBible('script');
      assert.match(bible, /Ramon/);

      const scenes = await breakdownScenes('script');
      assert.equal(scenes.length, 3);
      assert.equal(scenes[0].heading, 'SCENE 1');
      assert.equal(scenes[2].mood, 'grim');
    });
  } finally {
    await pilot.close();
  }
});

test('breakdownScenes accepts a nested scene array and alternate field names', async () => {
  const pilot = await startPilot({
    scenes: [{ title: 'S1', voiceover: 'Narration.', description: 'Shot.', tone: 'warm' }],
  });
  try {
    await withPilot({ KAGGLE_PILOT_URL: pilot.url }, async () => {
      const scenes = await breakdownScenes('script');
      assert.equal(scenes[0].heading, 'S1');
      assert.equal(scenes[0].narration, 'Narration.');
      assert.equal(scenes[0].visual, 'Shot.');
      assert.equal(scenes[0].mood, 'warm');
    });
  } finally {
    await pilot.close();
  }
});

test('a configured-but-down Pilot throws PilotUnavailable with code PILOT_UNAVAILABLE', async () => {
  const pilot = await startPilot();
  const url = pilot.url;
  await pilot.close();
  await withPilot({ KAGGLE_PILOT_URL: url, OLLAMA_DISABLE: '1' }, async () => {
    await assert.rejects(
      () => generateScript('brief'),
      (error: any) => {
        assert.ok(error instanceof PilotUnavailable);
        assert.equal(error.code, PILOT_UNAVAILABLE);
        assert.equal(error.status, 503);
        return true;
      },
    );
  });
});

test('an unconfigured Pilot throws PilotUnavailable without any network call', async () => {
  await withPilot({ KAGGLE_PILOT_URL: '', OLLAMA_DISABLE: '1' }, async () => {
    await assert.rejects(() => generateScript('brief'), (error: any) => error.code === PILOT_UNAVAILABLE);
  });
});

test('an HTTP error from the worker becomes PilotUnavailable, not a crash', async () => {
  const pilot = await startPilot({ fail: 500 });
  try {
    await withPilot({ KAGGLE_PILOT_URL: pilot.url, OLLAMA_DISABLE: '1' }, async () => {
      await assert.rejects(() => generateScript('brief'), (error: any) => {
        assert.ok(error instanceof PilotUnavailable);
        assert.match(error.detail, /500/);
        return true;
      });
    });
  } finally {
    await pilot.close();
  }
});

test('a dead Kaggle tunnel falls back to the local Ollama (T1)', async () => {
  const kaggle = await deadUrl();
  const ollama = await startOllama({ reply: GATE_PASSING_SCRIPT });
  try {
    await withPilot({ KAGGLE_PILOT_URL: kaggle, LOCAL_OLLAMA_URL: ollama.url, OLLAMA_DISABLE: '' }, async () => {
      const answer = await generateScriptAnswer('Isang mangingisda sa probinsya.');
      assert.equal(answer.source, 'local-ollama');
      assert.equal(answer.value, GATE_PASSING_SCRIPT);
      // The local model really received the brief.
      assert.match(String(ollama.lastBody().messages.at(-1).content), /mangingisda/);
    });
  } finally {
    await ollama.close();
  }
});

test('an unset KAGGLE_PILOT_URL also uses the local Ollama', async () => {
  const ollama = await startOllama();
  try {
    await withPilot({ KAGGLE_PILOT_URL: '', LOCAL_OLLAMA_URL: ollama.url, OLLAMA_DISABLE: '' }, async () => {
      const answer = await generateScriptAnswer('brief');
      assert.equal(answer.source, 'local-ollama');
    });
  } finally {
    await ollama.close();
  }
});

test('writeScreenplay reports the source and stores the local script', async () => {
  const kaggle = await deadUrl();
  const ollama = await startOllama({ reply: GATE_PASSING_SCRIPT });
  try {
    await withPilot({ KAGGLE_PILOT_URL: kaggle, LOCAL_OLLAMA_URL: ollama.url, OLLAMA_DISABLE: '' }, async () => {
      const result = await writeScreenplay('brief');
      assert.equal(result.source, 'local-ollama');
      assert.equal(result.script, GATE_PASSING_SCRIPT);
      assert.equal(result.model, 'qwen2.5:7b');
    });
  } finally {
    await ollama.close();
  }
});

test('both workers down -> honest PilotUnavailable naming both', async () => {
  const kaggle = await deadUrl();
  await withPilot({ KAGGLE_PILOT_URL: kaggle, OLLAMA_DISABLE: '1' }, async () => {
    await assert.rejects(() => generateScript('brief'), (error: any) => {
      assert.ok(error instanceof PilotUnavailable);
      assert.match(error.detail, /Ollama/);
      return true;
    });
  });
});

test('pilotStatus reports the local Ollama and the preferred worker', async () => {
  const kaggle = await deadUrl();
  const ollama = await startOllama();
  try {
    await withPilot({ KAGGLE_PILOT_URL: kaggle, LOCAL_OLLAMA_URL: ollama.url, OLLAMA_DISABLE: '' }, async () => {
      const status = await pilotStatus();
      assert.equal(status.local.reachable, true);
      assert.equal(status.local.model_present, true);
      assert.equal(status.preferred, 'local-ollama');
    });
  } finally {
    await ollama.close();
  }
});

test('a live Kaggle worker wins over the local Ollama', async () => {
  const pilot = await startPilot({ script: 'KAGGLE SCRIPT' });
  const ollama = await startOllama({ reply: GATE_PASSING_SCRIPT });
  try {
    await withPilot({ KAGGLE_PILOT_URL: pilot.url, LOCAL_OLLAMA_URL: ollama.url, OLLAMA_DISABLE: '' }, async () => {
      const answer = await generateScriptAnswer('brief');
      assert.equal(answer.source, 'kaggle');
      assert.equal(answer.value, 'KAGGLE SCRIPT');
      const status = await pilotStatus();
      assert.equal(status.preferred, 'kaggle');
    });
  } finally {
    await pilot.close();
    await ollama.close();
  }
});

/**
 * A minimal script that satisfies the gate: three scenes, each with a VISUAL and
 * a NARRATION, plus a title. The gate now runs on the local path, so a fixture
 * that is not screenplay-shaped would be rejected before it could prove anything
 * about routing.
 */
const GATE_PASSING_SCRIPT = [
  'PAMAGAT: Ang Bagong Tala',
  '',
  'EKSENA 1: Dalampasigan - Umaga',
  'VISUAL: Ang dagat ay kalmado at ang bangka ay nakahimpil sa buhangin.',
  'NARRATION: Si Mang Nestor ay naghahanda ng kanyang lambat para sa araw.',
  '',
  'EKSENA 2: Dalampasigan - Hapon',
  'VISUAL: Ang mga lambat ay puno ng isda at ang araw ay unti-unting lumulubog.',
  'NARRATION: Masaya siyang umuwi dahil sagana ang kanyang huli ngayon.',
  '',
  'EKSENA 3: Bahay ni Mang Nestor - Gabi',
  'VISUAL: Ang maliit na bahay ay may ilaw at amoy ng sinaing sa kusina.',
  'NARRATION: Ikinuwento niya sa kanyang pamilya ang magandang araw sa dagat.',
].join('\n');

/** A stand-in Gemini endpoint, so the router path is exercised for real. */
function startGemini(opts: { text?: string } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: opts.text ?? 'GEMINI SCRIPT: ang bagong tala.' }] } }],
      }));
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

test('a configured Gemini key writes the screenplay through the router', async () => {
  const gemini = await startGemini({ text: GATE_PASSING_SCRIPT });
  try {
    await withPilot(
      {
        KAGGLE_PILOT_URL: '',
        GEMINI_API_KEY: 'test-gemini-key',
        GEMINI_API_BASE: gemini.url,
        OLLAMA_DISABLE: '1',
      },
      async () => {
        const answer = await generateScriptAnswer('Isang mangingisda sa probinsya.');
        assert.equal(answer.source, 'gemini');
        assert.equal(answer.value, GATE_PASSING_SCRIPT);
        assert.match(String(answer.model), /^gemini-/);
      },
    );
  } finally {
    await gemini.close();
  }
});

test('custom endpoint paths are honoured', async () => {
  const pilot = await startPilot({ script: 'Mula sa custom path.' });
  try {
    await withPilot(
      { KAGGLE_PILOT_URL: pilot.url, KAGGLE_PILOT_SCRIPT_PATH: '/generate_script' },
      async () => {
        assert.equal(await generateScript('brief'), 'Mula sa custom path.');
      },
    );
  } finally {
    await pilot.close();
  }
});
