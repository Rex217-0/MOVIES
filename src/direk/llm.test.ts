import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  ollamaStatus, ollamaChat, preferredTextBackend, ollamaUrl, ollamaModel,
} from './llm.ts';

/** A minimal stand-in for the Ollama HTTP API. */
function startOllama(opts: { models?: string[]; reply?: string; fail?: boolean } = {}) {
  const models = opts.models ?? ['qwen2.5:7b'];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ models: models.map(name => ({ name })) }));
      return;
    }
    if (req.url === '/api/chat') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (opts.fail) {
          res.statusCode = 500;
          res.end('model not found');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: { content: opts.reply ?? '{"intent":"OK"}' } }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
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

async function withOllama<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ['OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_DISABLE', 'GEMINI_API_KEY']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
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

test('ollamaUrl and ollamaModel have sane defaults and trim trailing slashes', () => {
  assert.equal(ollamaUrl(), 'http://127.0.0.1:11434');
  assert.equal(ollamaModel(), 'qwen2.5:7b');
});

test('ollamaStatus reports the model as present when it is pulled', async () => {
  const mock = await startOllama({ models: ['llama3:8b', 'qwen2.5:7b'] });
  try {
    await withOllama({ OLLAMA_URL: mock.url, OLLAMA_MODEL: 'qwen2.5:7b' }, async () => {
      const status = await ollamaStatus();
      assert.equal(status.reachable, true);
      assert.equal(status.model_present, true);
      assert.deepEqual(status.models, ['llama3:8b', 'qwen2.5:7b']);
    });
  } finally {
    await mock.close();
  }
});

test('ollamaStatus reports model_present=false when the model is missing', async () => {
  const mock = await startOllama({ models: ['llama3:8b'] });
  try {
    await withOllama({ OLLAMA_URL: mock.url, OLLAMA_MODEL: 'qwen2.5:7b' }, async () => {
      const status = await ollamaStatus();
      assert.equal(status.reachable, true);
      assert.equal(status.model_present, false);
    });
  } finally {
    await mock.close();
  }
});

test('ollamaStatus is unreachable and explains why when nothing is listening', async () => {
  await withOllama({ OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'x' }, async () => {
    const status = await ollamaStatus();
    assert.equal(status.reachable, false);
    assert.ok(status.error);
  });
});

test('ollamaStatus honours OLLAMA_DISABLE without touching the network', async () => {
  await withOllama({ OLLAMA_DISABLE: '1' }, async () => {
    const status = await ollamaStatus();
    assert.equal(status.reachable, false);
    assert.match(status.error || '', /disabled/);
  });
});

test('ollamaChat returns the assistant text', async () => {
  const mock = await startOllama({ reply: 'Tactical assessment ready.' });
  try {
    await withOllama({ OLLAMA_URL: mock.url, OLLAMA_MODEL: 'qwen2.5:7b' }, async () => {
      const out = await ollamaChat({
        system: 'You are a pilot.',
        messages: [{ role: 'user', content: 'scan the sector' }],
      });
      assert.equal(out, 'Tactical assessment ready.');
    });
  } finally {
    await mock.close();
  }
});

test('ollamaChat surfaces a server error instead of faking a reply', async () => {
  const mock = await startOllama({ fail: true });
  try {
    await withOllama({ OLLAMA_URL: mock.url, OLLAMA_MODEL: 'qwen2.5:7b' }, async () => {
      await assert.rejects(() => ollamaChat({ messages: [{ role: 'user', content: 'hi' }] }), /500/);
    });
  } finally {
    await mock.close();
  }
});

test('preferredTextBackend prefers Gemini, then Ollama, and respects the disable switch', async () => {
  await withOllama({ GEMINI_API_KEY: 'k' }, async () => {
    assert.equal(preferredTextBackend(), 'gemini');
  });
  await withOllama({}, async () => {
    assert.equal(preferredTextBackend(), 'ollama');
  });
  await withOllama({ OLLAMA_DISABLE: '1' }, async () => {
    assert.equal(preferredTextBackend(), 'none');
  });
});

test('ollamaStatus does not confuse a different tag of the same family (qwen2.5:3b vs 7b)', async () => {
  // Boss Rex has only qwen2.5:3b pulled. The app default asks for qwen2.5:7b.
  // Reporting "present" here would make the status lie; the call then fails.
  const mock = await startOllama({ models: ['qwen2.5:3b'] });
  try {
    await withOllama({ OLLAMA_URL: mock.url, OLLAMA_MODEL: 'qwen2.5:7b' }, async () => {
      const status = await ollamaStatus();
      assert.equal(status.reachable, true);
      assert.equal(status.model_present, false);
    });
    await withOllama({ OLLAMA_URL: mock.url, OLLAMA_MODEL: 'qwen2.5:3b' }, async () => {
      const status = await ollamaStatus();
      assert.equal(status.model_present, true);
    });
  } finally {
    await mock.close();
  }
});

test('an untagged model name matches its :latest tag', async () => {
  const mock = await startOllama({ models: ['llama3:latest'] });
  try {
    await withOllama({ OLLAMA_URL: mock.url, OLLAMA_MODEL: 'llama3' }, async () => {
      assert.equal((await ollamaStatus()).model_present, true);
    });
  } finally {
    await mock.close();
  }
});
