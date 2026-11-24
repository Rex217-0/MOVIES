import test from 'node:test';
import assert from 'node:assert/strict';
import {
  swarmUrl, swarmConfigured, swarmSession, checkSwarmReachability,
  generateWithSwarm, swarmAvailable,
} from './swarmui.ts';
import { startMockSwarmUI, withMockSwarmUI, TINY_PNG } from '../testing/swarmuiMock.ts';

test('swarmUrl defaults to port 7801 and strips trailing slashes', () => {
  const saved = process.env.SWARMUI_URL;
  delete process.env.SWARMUI_URL;
  assert.equal(swarmUrl(), 'http://127.0.0.1:7801');
  process.env.SWARMUI_URL = 'http://192.168.1.60:7801/';
  assert.equal(swarmUrl(), 'http://192.168.1.60:7801');
  if (saved === undefined) delete process.env.SWARMUI_URL;
  else process.env.SWARMUI_URL = saved;
});

test('swarmConfigured is false only when SWARMUI_URL is unset or blank', () => {
  const saved = process.env.SWARMUI_URL;
  delete process.env.SWARMUI_URL;
  assert.equal(swarmConfigured(), false);
  process.env.SWARMUI_URL = '   ';
  assert.equal(swarmConfigured(), false);
  process.env.SWARMUI_URL = 'http://127.0.0.1:7801';
  assert.equal(swarmConfigured(), true);
  if (saved === undefined) delete process.env.SWARMUI_URL;
  else process.env.SWARMUI_URL = saved;
});

test('a session is opened with a POST and returns the server session id', async () => {
  await withMockSwarmUI(async mock => {
    const session = await swarmSession();
    assert.equal(session.session_id, 'session-1');
    assert.equal(session.user_id, 'local');
    // GetNewSession must be a POST with a JSON body, like every SwarmUI route.
    const call = mock.received().find(r => r.path === 'getnewsession');
    assert.ok(call, 'GetNewSession was never called');
    assert.deepEqual(call.body, {});
  });
});

test('the status probe sends session_id in the body and reports the backend', async () => {
  await withMockSwarmUI(async mock => {
    const r = await checkSwarmReachability();
    assert.equal(r.reachable, true);
    assert.equal(r.error, '');
    assert.equal(r.url, mock.url);
    assert.equal(r.backend_status?.status, 'running');
    assert.deepEqual(r.queue, { waiting_gens: 0, loading_models: 0, waiting_backends: 0, live_gens: 0 });
    assert.deepEqual(r.supported_features, ['param_seed', 'param_steps']);
    assert.ok(typeof r.latency_ms === 'number' && r.latency_ms >= 0);

    const status = mock.received().find(x => x.path === 'getcurrentstatus');
    assert.ok(status, 'GetCurrentStatus was never called');
    // The session id travels inside the body, not as a query string or header.
    assert.equal(status.body.session_id, 'session-1');
  });
});

test('a status error is reported as unreachable and quotes SwarmUI itself', async () => {
  await withMockSwarmUI(async () => {
    const r = await checkSwarmReachability();
    assert.equal(r.reachable, false);
    assert.match(r.error, /hindi maabot ang SwarmUI/);
    assert.match(String(r.detail), /backend is not ready/);
  }, { statusError: 'backend is not ready' });
});

test('an unreachable host is reported with the exact URL, never as alive', async () => {
  const saved = process.env.SWARMUI_URL;
  // Port 1 on loopback refuses connections, so this exercises the real failure.
  process.env.SWARMUI_URL = 'http://127.0.0.1:1';
  try {
    const r = await checkSwarmReachability();
    assert.equal(r.reachable, false);
    assert.equal(r.url, 'http://127.0.0.1:1');
    assert.match(r.error, /http:\/\/127\.0\.0\.1:1/);
    assert.ok(r.detail && r.detail.length > 0, 'the cause must be named');
    assert.equal(await swarmAvailable(), false);
  } finally {
    if (saved === undefined) delete process.env.SWARMUI_URL;
    else process.env.SWARMUI_URL = saved;
  }
});

test('generation sends every parameter flat at the root, beside images', async () => {
  await withMockSwarmUI(async mock => {
    const png = await generateWithSwarm('a neon city at night', {
      negative: 'blurry', width: 832, height: 1216, steps: 24, cfgScale: 6.5, seed: 42,
    });
    assert.ok(Buffer.isBuffer(png));
    assert.deepEqual(png, TINY_PNG, 'the bytes served by /View must come back unchanged');

    const gen = mock.received().find(x => x.path === 'generatetext2image');
    assert.ok(gen, 'GenerateText2Image was never called');
    // SwarmUI reads the whole body as the parameter map: nesting these under
    // rawInput would silently drop every setting.
    assert.equal(gen.body.session_id, 'session-1');
    assert.equal(gen.body.images, 1);
    assert.equal(gen.body.prompt, 'a neon city at night');
    assert.equal(gen.body.negativeprompt, 'blurry');
    assert.equal(gen.body.width, 832);
    assert.equal(gen.body.height, 1216);
    assert.equal(gen.body.steps, 24);
    assert.equal(gen.body.cfgscale, 6.5);
    assert.equal(gen.body.seed, 42);
    assert.equal(gen.body.rawInput, undefined, 'parameters must not be nested under rawInput');
  });
});

test('generation omits the model unless one is chosen', async () => {
  await withMockSwarmUI(async mock => {
    await generateWithSwarm('a cat');
    let gen = mock.received().find(x => x.path === 'generatetext2image');
    assert.equal(gen!.body.model, undefined);
  });
  await withMockSwarmUI(async mock => {
    await generateWithSwarm('a cat', { model: 'OfficialStableDiffusion/sd_xl_base_1.0' });
    const gen = mock.received().find(x => x.path === 'generatetext2image');
    assert.equal(gen!.body.model, 'OfficialStableDiffusion/sd_xl_base_1.0');
  });
});

test('an inline data URL is decoded without a second request', async () => {
  await withMockSwarmUI(async mock => {
    const png = await generateWithSwarm('a cat');
    assert.deepEqual(png, TINY_PNG);
    assert.equal(mock.hits('/View/'), 0, 'a data URL must not trigger a /View fetch');
  }, { inlineImage: true });
});

test('a generation error from SwarmUI is thrown, not returned as an image', async () => {
  await withMockSwarmUI(async () => {
    await assert.rejects(
      () => generateWithSwarm('a cat'),
      /no backend available/,
    );
  }, { generateError: 'no backend available' });
});

test('generation against a dead host rejects instead of hanging', async () => {
  const saved = process.env.SWARMUI_URL;
  process.env.SWARMUI_URL = 'http://127.0.0.1:1';
  try {
    await assert.rejects(() => generateWithSwarm('a cat'), /GetNewSession/);
  } finally {
    if (saved === undefined) delete process.env.SWARMUI_URL;
    else process.env.SWARMUI_URL = saved;
  }
});

test('a server that answers without a session id is refused', async () => {
  // A misconfigured proxy may return 200 with an unrelated body; that must not
  // be mistaken for a working SwarmUI.
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ hello: 'world' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const saved = process.env.SWARMUI_URL;
  process.env.SWARMUI_URL = `http://127.0.0.1:${port}`;
  try {
    await assert.rejects(() => swarmSession(), /did not return a session_id/);
    const r = await checkSwarmReachability();
    assert.equal(r.reachable, false);
  } finally {
    if (saved === undefined) delete process.env.SWARMUI_URL;
    else process.env.SWARMUI_URL = saved;
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('each generation opens its own session', async () => {
  const mock = await startMockSwarmUI();
  const saved = process.env.SWARMUI_URL;
  process.env.SWARMUI_URL = mock.url;
  try {
    await generateWithSwarm('first');
    await generateWithSwarm('second');
    assert.equal(mock.hits('getnewsession'), 2);
    const prompts = mock.received()
      .filter(r => r.path === 'generatetext2image')
      .map(r => r.body.prompt);
    assert.deepEqual(prompts, ['first', 'second']);
  } finally {
    if (saved === undefined) delete process.env.SWARMUI_URL;
    else process.env.SWARMUI_URL = saved;
    await mock.close();
  }
});
