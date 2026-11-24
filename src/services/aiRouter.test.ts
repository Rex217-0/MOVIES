import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  generateTextWithFallback,
  hasConfiguredTextProvider,
  configuredTextProviders,
  sanitizeError,
  isAiUnavailable,
  AiUnavailableError,
} from './aiRouter.ts';

/**
 * A stand-in provider over a real HTTP server, so every request path in the
 * router is exercised for real instead of mocked. `reply` decides the status and
 * body; the recorded requests let a test assert what was actually sent.
 */
interface Fake {
  url: string;
  close: () => Promise<void>;
  requests: { path: string; headers: http.IncomingHttpHeaders; body: any }[];
}

function startFake(opts: {
  status?: number;
  body?: unknown;
  /** Per-request reply, for a provider that must be retried or must fail once. */
  handler?: (req: { body: any; index: number }) => { status: number; body: unknown };
} = {}): Promise<Fake> {
  const requests: Fake['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: any = raw;
      try { body = JSON.parse(raw); } catch { /* keep the raw string */ }
      const index = requests.length;
      requests.push({ path: req.url || '', headers: req.headers, body });
      const reply = opts.handler ? opts.handler({ body, index }) : undefined;
      res.statusCode = reply?.status ?? opts.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply ? reply.body : opts.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        requests,
      });
    });
  });
}

const ENV_KEYS = [
  'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'APP_AUTH_TOKEN',
  'KAGGLE_PILOT_TOKEN', 'OLLAMA_DISABLE', 'LOCAL_OLLAMA_URL', 'OLLAMA_URL', 'OLLAMA_MODEL',
  'GEMINI_API_BASE', 'DEEPSEEK_API_BASE', 'ANTHROPIC_API_BASE',
  'GEMINI_TEXT_MODELS', 'DEEPSEEK_MODEL', 'ANTHROPIC_MODEL',
];

/** Run `fn` with exactly this environment, then put the old one back. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const GEMINI_BODY = { candidates: [{ content: { parts: [{ text: 'Mula kay Gemini.' }] } }] };
const DEEPSEEK_BODY = { choices: [{ message: { content: 'Mula kay DeepSeek.' } }] };
const CLAUDE_BODY = { content: [{ text: 'Mula kay Claude.' }] };
const OLLAMA_BODY = { message: { content: 'Mula kay Ollama.' } };

test('no provider configured at all reports honestly instead of guessing', async () => {
  await withEnv({ OLLAMA_DISABLE: '1' }, async () => {
    assert.equal(hasConfiguredTextProvider(), false);
    assert.deepEqual(configuredTextProviders(), []);
    await assert.rejects(
      () => generateTextWithFallback([{ role: 'user', content: 'hi' }]),
      (error: any) => {
        assert.ok(error instanceof AiUnavailableError);
        assert.equal(error.code, 'AI_UNAVAILABLE');
        assert.match(error.message, /no text provider is configured/);
        return true;
      },
    );
  });
});

test('Gemini answers first when its key is set, and the system turn is split out', async () => {
  const fake = await startFake({ body: GEMINI_BODY });
  try {
    await withEnv(
      { GEMINI_API_KEY: 'test-gemini-key', GEMINI_API_BASE: fake.url, OLLAMA_DISABLE: '1' },
      async () => {
        const result = await generateTextWithFallback([
          { role: 'system', content: 'Ikaw si Direk.' },
          { role: 'user', content: 'Gumawa ng screenplay.' },
        ]);
        assert.equal(result.provider, 'gemini');
        assert.equal(result.text, 'Mula kay Gemini.');

        const sent = fake.requests.at(-1)!;
        assert.match(sent.path, /:generateContent$/);
        assert.equal(sent.body.systemInstruction.parts[0].text, 'Ikaw si Direk.');
        assert.equal(sent.body.contents.length, 1, 'the system turn must not be a content turn');
        assert.equal(sent.body.contents[0].role, 'user');
        // The key travels in a header, never in the URL where it would be logged.
        assert.equal(sent.headers['x-goog-api-key'], 'test-gemini-key');
        assert.doesNotMatch(sent.path, /test-gemini-key/);
      },
    );
  } finally {
    await fake.close();
  }
});

test('a failing Gemini falls through to DeepSeek', async () => {
  const gemini = await startFake({ status: 500, body: { error: { message: 'boom' } } });
  const deepseek = await startFake({ body: DEEPSEEK_BODY });
  try {
    await withEnv(
      {
        GEMINI_API_KEY: 'test-gemini-key',
        GEMINI_API_BASE: gemini.url,
        DEEPSEEK_API_KEY: 'test-deepseek-key',
        DEEPSEEK_API_BASE: deepseek.url,
        OLLAMA_DISABLE: '1',
      },
      async () => {
        const result = await generateTextWithFallback([{ role: 'user', content: 'hi' }]);
        assert.equal(result.provider, 'deepseek');
        assert.equal(result.text, 'Mula kay DeepSeek.');
        assert.equal(result.model, 'deepseek-chat');
        assert.equal(deepseek.requests.at(-1)!.headers.authorization, 'Bearer test-deepseek-key');
      },
    );
  } finally {
    await gemini.close();
    await deepseek.close();
  }
});

test('the order is Gemini, DeepSeek, Claude, then Ollama', async () => {
  await withEnv(
    {
      GEMINI_API_KEY: 'k1', DEEPSEEK_API_KEY: 'k2', ANTHROPIC_API_KEY: 'k3',
      OLLAMA_DISABLE: '',
    },
    async () => {
      assert.deepEqual(configuredTextProviders(), ['gemini', 'deepseek', 'claude', 'ollama']);
    },
  );
});

test('every provider failing produces AI_UNAVAILABLE naming each one', async () => {
  const dead = await startFake({ status: 500, body: { error: 'nope' } });
  try {
    await withEnv(
      {
        GEMINI_API_KEY: 'k1', GEMINI_API_BASE: dead.url, GEMINI_TEXT_MODELS: 'only-model',
        DEEPSEEK_API_KEY: 'k2', DEEPSEEK_API_BASE: dead.url,
        ANTHROPIC_API_KEY: 'k3', ANTHROPIC_API_BASE: dead.url,
        LOCAL_OLLAMA_URL: dead.url, OLLAMA_DISABLE: '',
      },
      async () => {
        await assert.rejects(
          () => generateTextWithFallback([{ role: 'user', content: 'hi' }]),
          (error: any) => {
            assert.ok(isAiUnavailable(error));
            assert.match(error.message, /Gemini:/);
            assert.match(error.message, /DeepSeek:/);
            assert.match(error.message, /Claude:/);
            assert.match(error.message, /Ollama:/);
            return true;
          },
        );
      },
    );
  } finally {
    await dead.close();
  }
});

test('a key echoed back by a provider never reaches the error message', async () => {
  const secret = 'super-secret-key-value-12345';
  // The provider repeats the key in its error body, as real ones sometimes do.
  const echoing = await startFake({ status: 401, body: { error: `bad key ${secret}` } });
  try {
    await withEnv(
      {
        GEMINI_API_KEY: secret, GEMINI_API_BASE: echoing.url, GEMINI_TEXT_MODELS: 'only-model',
        OLLAMA_DISABLE: '1',
      },
      async () => {
        await assert.rejects(
          () => generateTextWithFallback([{ role: 'user', content: 'hi' }]),
          (error: any) => {
            assert.doesNotMatch(error.message, new RegExp(secret));
            assert.match(error.message, /\[REDACTED\]/);
            return true;
          },
        );
      },
    );
  } finally {
    await echoing.close();
  }
});

test('sanitizeError removes env secrets and key-shaped strings', async () => {
  await withEnv({ GEMINI_API_KEY: 'env-secret-value-abcdef' }, async () => {
    const out = sanitizeError(
      new Error('failed with env-secret-value-abcdef and AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and Bearer abcdefghijklmnop'),
    );
    assert.doesNotMatch(out, /env-secret-value-abcdef/);
    assert.doesNotMatch(out, /AIzaSy/);
    assert.doesNotMatch(out, /abcdefghijklmnop/);
    assert.match(out, /\[REDACTED\]/);
  });
});

test('JSON mode is requested from each provider that supports it', async () => {
  const gemini = await startFake({ body: GEMINI_BODY });
  try {
    await withEnv(
      { GEMINI_API_KEY: 'k1', GEMINI_API_BASE: gemini.url, OLLAMA_DISABLE: '1' },
      async () => {
        await generateTextWithFallback([{ role: 'user', content: 'json pls' }], { json: true });
        assert.equal(gemini.requests.at(-1)!.body.generationConfig.responseMimeType, 'application/json');
      },
    );
  } finally {
    await gemini.close();
  }

  const ollama = await startFake({ body: OLLAMA_BODY });
  try {
    await withEnv({ LOCAL_OLLAMA_URL: ollama.url, OLLAMA_DISABLE: '' }, async () => {
      const result = await generateTextWithFallback([{ role: 'user', content: 'json pls' }], { json: true });
      assert.equal(result.provider, 'ollama');
      assert.equal(result.text, 'Mula kay Ollama.');
      assert.equal(ollama.requests.at(-1)!.body.format, 'json');
    });
  } finally {
    await ollama.close();
  }
});

test('Claude receives the system prompt as `system`, not as a message', async () => {
  const claude = await startFake({ body: CLAUDE_BODY });
  try {
    await withEnv(
      { ANTHROPIC_API_KEY: 'k3', ANTHROPIC_API_BASE: claude.url, OLLAMA_DISABLE: '1' },
      async () => {
        const result = await generateTextWithFallback([
          { role: 'system', content: 'Ikaw si Direk.' },
          { role: 'user', content: 'hi' },
        ]);
        assert.equal(result.provider, 'claude');
        const sent = claude.requests.at(-1)!;
        assert.equal(sent.body.system, 'Ikaw si Direk.');
        assert.deepEqual(sent.body.messages, [{ role: 'user', content: 'hi' }]);
        assert.equal(sent.headers['x-api-key'], 'k3');
        assert.equal(sent.headers['anthropic-version'], '2026-10-21');
      },
    );
  } finally {
    await claude.close();
  }
});

test('Claude falls through to the next model when one is retired', async () => {
  // The API answers 404 for a retired model; the chain must move on rather than
  // failing the whole provider, which is what the old pinned default did.
  let call = 0;
  const claude = await startFake({
    handler: (req) => {
      call += 1;
      if (call === 1) {
        return { status: 404, body: { error: { message: 'model: not found' } } };
      }
      return { status: 200, body: CLAUDE_BODY };
    },
  });
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: 'k3',
        ANTHROPIC_API_BASE: claude.url,
        ANTHROPIC_MODEL: 'retired-model,claude-sonnet-5-5',
        OLLAMA_DISABLE: '1',
      },
      async () => {
        const result = await generateTextWithFallback([{ role: 'user', content: 'hi' }]);
        assert.equal(result.provider, 'claude');
        assert.equal(result.model, 'claude-sonnet-5-5');
        assert.equal(claude.requests.length, 2);
      },
    );
  } finally {
    await claude.close();
  }
});

test('the Claude version header can be overridden without a code change', async () => {
  const claude = await startFake({ body: CLAUDE_BODY });
  try {
    await withEnv(
      {
        ANTHROPIC_API_KEY: 'k3',
        ANTHROPIC_API_BASE: claude.url,
        ANTHROPIC_VERSION: '2025-01-01',
        OLLAMA_DISABLE: '1',
      },
      async () => {
        await generateTextWithFallback([{ role: 'user', content: 'hi' }]);
        assert.equal(claude.requests.at(-1)!.headers['anthropic-version'], '2025-01-01');
      },
    );
  } finally {
    await claude.close();
  }
});

test('an empty provider response is treated as a failure, not as text', async () => {
  const empty = await startFake({ body: { candidates: [{ content: { parts: [{ text: '   ' }] } }] } });
  const ollama = await startFake({ body: OLLAMA_BODY });
  try {
    await withEnv(
      {
        GEMINI_API_KEY: 'k1', GEMINI_API_BASE: empty.url, GEMINI_TEXT_MODELS: 'only-model',
        LOCAL_OLLAMA_URL: ollama.url, OLLAMA_DISABLE: '',
      },
      async () => {
        const result = await generateTextWithFallback([{ role: 'user', content: 'hi' }]);
        assert.equal(result.provider, 'ollama', 'blank Gemini text must not win');
      },
    );
  } finally {
    await empty.close();
    await ollama.close();
  }
});

test('an empty message list is rejected before any network call', async () => {
  await assert.rejects(() => generateTextWithFallback([]), /at least one message/);
});
