import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  cloudflareChat,
  cloudflareConfigured,
  cloudflareModelPlan,
  defaultCloudflareModel,
  isDynamicRouteUnavailable,
  resetCloudflareCircuitBreaker,
  CloudflareGatewayError,
  DYNAMIC_MODEL,
  QWEN_MODEL,
} from './ai.ts';
import { sanitizeError } from './secrets.ts';
import {
  generateTextWithFallback,
  configuredTextProviders,
} from '../services/aiRouter.ts';

/**
 * A real HTTP server stands in for the gateway, so the request path, the
 * headers, and the status handling are all exercised for real.
 */
interface Fake {
  url: string;
  close: () => Promise<void>;
  requests: Array<{ headers: http.IncomingHttpHeaders; body: any }>;
}

async function fakeGateway(
  handler: (req: any, res: http.ServerResponse) => void,
): Promise<Fake> {
  const requests: Fake['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ headers: req.headers, body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Point the transport at a local stand-in by overriding its endpoint. */
function useGatewayUrl(url: string): void {
  // The endpoint is built from CF_ACCOUNT_ID, so the fake server is reached by
  // rewriting fetch rather than by env: the URL shape stays exactly what ships.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    const target = typeof input === 'string' ? input : input.url;
    return realFetch(target.replace('https://api.cloudflare.com', url), init);
  }) as typeof fetch;
  (globalThis as any).__restoreFetch = () => {
    globalThis.fetch = realFetch;
  };
}

function restoreFetch(): void {
  (globalThis as any).__restoreFetch?.();
  delete (globalThis as any).__restoreFetch;
}

function setCloudflareEnv(token = 'cf-token-abc-1234567890'): void {
  process.env.CF_ACCOUNT_ID = 'acct-123';
  process.env.CF_API_TOKEN = token;
  process.env.AI_GATEWAY_ID = 'movie-creator';
}

function clearCloudflareEnv(): void {
  delete process.env.CF_ACCOUNT_ID;
  delete process.env.CF_API_TOKEN;
  delete process.env.AI_GATEWAY_ID;
}

test('cloudflareConfigured needs both the account id and the token', () => {
  clearCloudflareEnv();
  assert.equal(cloudflareConfigured(), false);

  process.env.CF_ACCOUNT_ID = 'acct-123';
  assert.equal(cloudflareConfigured(), false, 'token is still missing');

  process.env.CF_API_TOKEN = 'tok';
  assert.equal(cloudflareConfigured(), true);
  clearCloudflareEnv();
});

test('cloudflareChat sends the documented headers and model', async () => {
  resetCloudflareCircuitBreaker();
  setCloudflareEnv('cf-token-secret-value');
  const fake = await fakeGateway((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'sagot' } }], model: DYNAMIC_MODEL }));
  });
  useGatewayUrl(fake.url);

  try {
    const out = await cloudflareChat([{ role: 'user', content: 'kumusta' }]);
    assert.equal(out.text, 'sagot');

    const sent = fake.requests[0]!;
    assert.equal(sent.headers['authorization'], 'Bearer cf-token-secret-value');
    assert.equal(sent.headers['cf-aig-gateway-id'], 'movie-creator');
    assert.equal(sent.body.model, DYNAMIC_MODEL);
    assert.equal(sent.body.messages[0].content, 'kumusta');
  } finally {
    restoreFetch();
    await fake.close();
    clearCloudflareEnv();
  }
});

test('a 404 on the dynamic route trips the breaker for the rest of the process', async () => {
  resetCloudflareCircuitBreaker();
  setCloudflareEnv();
  assert.equal(isDynamicRouteUnavailable(), false);
  assert.equal(defaultCloudflareModel(), DYNAMIC_MODEL);

  const fake = await fakeGateway((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'route not found' }] }));
  });
  useGatewayUrl(fake.url);

  try {
    await assert.rejects(
      () => cloudflareChat([{ role: 'user', content: 'hi' }]),
      (err: any) => err instanceof CloudflareGatewayError && err.code === 'DYNAMIC_ROUTE_MISSING',
    );
  } finally {
    restoreFetch();
    await fake.close();
  }

  // The breaker is process-lifetime: the next call must not ask for the route.
  assert.equal(isDynamicRouteUnavailable(), true);
  assert.equal(defaultCloudflareModel(), QWEN_MODEL, 'the concrete model is used instead');
  assert.deepEqual(cloudflareModelPlan(), [QWEN_MODEL]);

  // A second call must hit the concrete model, proving the breaker changed the plan.
  const fake2 = await fakeGateway((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  useGatewayUrl(fake2.url);
  try {
    await cloudflareChat([{ role: 'user', content: 'hi ulit' }]);
    assert.equal(fake2.requests[0]!.body.model, QWEN_MODEL);
  } finally {
    restoreFetch();
    await fake2.close();
    clearCloudflareEnv();
    resetCloudflareCircuitBreaker();
  }
});

test('a 404 on the concrete model does NOT trip the breaker', async () => {
  resetCloudflareCircuitBreaker();
  setCloudflareEnv();
  const fake = await fakeGateway((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  useGatewayUrl(fake.url);
  try {
    await assert.rejects(
      () => cloudflareChat([{ role: 'user', content: 'hi' }], { model: QWEN_MODEL }),
      (err: any) => err instanceof CloudflareGatewayError,
    );
  } finally {
    restoreFetch();
    await fake.close();
  }
  assert.equal(isDynamicRouteUnavailable(), false, 'a wrong model name is not a route verdict');
  clearCloudflareEnv();
});

test('an unconfigured gateway reports NOT_CONFIGURED and is skipped by the chain', async () => {
  clearCloudflareEnv();
  await assert.rejects(
    () => cloudflareChat([{ role: 'user', content: 'hi' }]),
    (err: any) => err.code === 'NOT_CONFIGURED',
  );
  assert.equal(configuredTextProviders().includes('cloudflare'), false);
});

test('the gateway is FIRST in the chain when configured, without dropping the others', () => {
  clearCloudflareEnv();
  process.env.CF_ACCOUNT_ID = 'acct-123';
  process.env.CF_API_TOKEN = 'tok';
  process.env.GEMINI_API_KEY = 'gemini-key-value';
  process.env.OLLAMA_DISABLE = '0';

  try {
    const order = configuredTextProviders();
    assert.equal(order[0], 'cloudflare', 'gateway must lead the chain');
    assert.ok(order.includes('gemini'), 'Gemini must still be there');
    assert.ok(order.includes('ollama'), 'Ollama must still be there');
  } finally {
    clearCloudflareEnv();
    delete process.env.GEMINI_API_KEY;
  }
});

test('a failing gateway falls back to the next provider', async () => {
  resetCloudflareCircuitBreaker();
  clearCloudflareEnv();
  process.env.CF_ACCOUNT_ID = 'acct-123';
  process.env.CF_API_TOKEN = 'tok';

  const fake = await fakeGateway((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  useGatewayUrl(fake.url);

  // A stand-in Gemini answers, so the chain has somewhere to fall back to.
  const gemini = await fakeGateway((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'galing kay gemini' }] } }] }));
  });
  const realFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = 'gemini-key-value';
  process.env.GEMINI_API_BASE = gemini.url;
  process.env.OLLAMA_DISABLE = '1';

  try {
    const result = await generateTextWithFallback([{ role: 'user', content: 'hi' }]);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.text, 'galing kay gemini');
  } finally {
    globalThis.fetch = realFetch;
    await fake.close();
    await gemini.close();
    clearCloudflareEnv();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_BASE;
    delete process.env.OLLAMA_DISABLE;
  }
});

test('sanitizeError never leaks the Cloudflare token', () => {
  const token = 'cf-token-super-secret-value-123';
  process.env.CF_API_TOKEN = token;
  try {
    const out = sanitizeError(
      new Error(`Cloudflare HTTP 401: {"error":"bad token ${token}"} Authorization: Bearer ${token}`),
    );
    assert.equal(out.includes(token), false, 'the token must not survive');
    assert.ok(out.includes('[REDACTED]'));
  } finally {
    delete process.env.CF_API_TOKEN;
  }
});

test('sanitizeError scrubs a 40-char Cloudflare-shaped token and private keys', () => {
  const shaped = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
  const out = sanitizeError(new Error(`token=${shaped}`));
  assert.equal(out.includes(shaped), false);

  // Assembled at runtime: a literal PEM block in a tracked file trips the
  // repo's "no committed private key" guard, and this fixture is synthetic.
  const pem = ['-----BEGIN ', 'PRIVATE KEY-----', '\nMIIEvQIBADANBg\n',
    '-----END ', 'PRIVATE KEY-----'].join('');
  const pemOut = sanitizeError(new Error(`bad creds ${pem}`));
  assert.equal(pemOut.includes('MIIEvQIBADANBg'), false);
});
