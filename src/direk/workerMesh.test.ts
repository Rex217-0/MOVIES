import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkerMesh, workerView, dispatchJob, dispatchToMesh, roleCanRun, isHeavyEngine,
} from './workerMesh.ts';

const T0 = 1_000_000;

function meshWith(workers: Array<{ id: string; engines?: string[]; max?: number; url?: string }>, ttlMs = 90_000, now = T0) {
  const mesh = new WorkerMesh({ ttlMs });
  for (const w of workers) {
    mesh.register(
      {
        id: w.id,
        url: w.url ?? `http://${w.id}:8090`,
        capabilities: w.engines ? { engines: w.engines } : {},
        maxConcurrent: w.max,
      },
      now,
    );
  }
  return mesh;
}

test('register lists a worker and never exposes its token', () => {
  const mesh = new WorkerMesh();
  mesh.register({ id: 'gpu-1', url: 'http://gpu-1:8090', token: 'secret', capabilities: { engines: ['comfyui'], vram_gb: 16 } }, T0);
  const list = mesh.list(T0);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'idle');
  assert.equal(list[0].capabilities.vram_gb, 16);
  const view = workerView(list[0]);
  assert.equal((view as any).token, undefined, 'the token must not leak to the UI');
});

test('a stale heartbeat marks the worker offline and frees the pool', () => {
  const mesh = meshWith([{ id: 'gpu-1', engines: ['comfyui'] }], 1000);
  assert.equal(mesh.online(T0).length, 1);
  assert.equal(mesh.online(T0 + 2000).length, 0, 'past the TTL it is offline');
  assert.equal(mesh.summary(T0 + 2000).offline, 1);
  // A fresh heartbeat brings it back.
  mesh.heartbeat('gpu-1', T0 + 3000);
  assert.equal(mesh.online(T0 + 3000).length, 1);
});

test('select only picks workers that advertise the engine', () => {
  const mesh = meshWith([
    { id: 'img', engines: ['comfyui'] },
    { id: 'cpu', engines: [] },
  ]);
  const comfy = mesh.select('comfyui', T0);
  assert.ok(comfy, 'a comfyui worker exists');
  assert.ok(['img', 'cpu'].includes(comfy!.id));
  // A worker with no engines listed accepts anything.
  assert.ok(mesh.select('tts', T0), 'the engine-less worker accepts tts');
});

test('select returns null when nothing advertises the engine', () => {
  const mesh = meshWith([{ id: 'img', engines: ['comfyui'] }]);
  assert.equal(mesh.select('tts', T0), null);
});

test('select spreads load: the least-busy worker wins, then round-robin', () => {
  const mesh = meshWith([
    { id: 'a', engines: ['comfyui'], max: 1 },
    { id: 'b', engines: ['comfyui'], max: 1 },
  ]);
  const first = mesh.select('comfyui', T0)!;
  assert.ok(mesh.acquire(first.id, T0));
  const second = mesh.select('comfyui', T0)!;
  assert.notEqual(second.id, first.id, 'the busy worker is skipped');
  // With both busy, nothing is eligible.
  assert.ok(mesh.acquire(second.id, T0));
  assert.equal(mesh.select('comfyui', T0), null);
  // Releasing one frees exactly one slot.
  mesh.release(first.id, true, T0);
  assert.ok(mesh.select('comfyui', T0));
});

test('acquire refuses a full worker and release records the outcome', () => {
  const mesh = meshWith([{ id: 'a', engines: ['comfyui'], max: 1 }]);
  assert.equal(mesh.acquire('a', T0), true);
  assert.equal(mesh.acquire('a', T0), false, 'the single slot is taken');
  mesh.release('a', false, T0);
  const worker = mesh.list(T0)[0];
  assert.equal(worker.failed, 1);
  assert.equal(worker.status, 'idle');
});

test('dispatchJob posts the job with the token and returns the output', async () => {
  const mesh = meshWith([{ id: 'a', engines: ['comfyui'] }], 90_000, Date.now());
  let seen: { url: string; auth?: string; body?: any } | null = null;
  const fakeFetch = (async (url: any, init: any) => {
    seen = { url: String(url), auth: init.headers?.Authorization, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ video: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  mesh.register({ id: 'a', url: 'http://a:8090', token: 'tok', capabilities: { engines: ['comfyui'] } }, Date.now());
  const result = await dispatchJob(mesh, 'a', { engine: 'comfyui', task: 'video_render', payload: { prompt: 'x' } }, { fetchImpl: fakeFetch });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { video: 'ok' });
  assert.equal(seen!.url, 'http://a:8090/job');
  assert.equal(seen!.auth, 'Bearer tok');
  assert.equal(seen!.body.engine, 'comfyui');
  assert.equal(mesh.list()[0].active, 0, 'the slot is released after the call');
});

test('dispatchJob reports a non-200 worker without throwing', async () => {
  const mesh = meshWith([{ id: 'a', engines: ['comfyui'] }], 90_000, Date.now());
  const fakeFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
  const result = await dispatchJob(mesh, 'a', { engine: 'comfyui', task: 'video_render', payload: {} }, { fetchImpl: fakeFetch });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /500/);
  assert.equal(mesh.list()[0].failed, 1);
});

test('dispatchJob reports a network failure without throwing', async () => {
  const mesh = meshWith([{ id: 'a', engines: ['comfyui'] }], 90_000, Date.now());
  const fakeFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const result = await dispatchJob(mesh, 'a', { engine: 'comfyui', task: 'video_render', payload: {} }, { fetchImpl: fakeFetch });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /ECONNREFUSED/);
});

test('dispatchToMesh fails honestly when no worker is available', async () => {
  const mesh = new WorkerMesh();
  const result = await dispatchToMesh(mesh, { engine: 'comfyui', task: 'video_render', payload: {} });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /Walang available/);
});

test('dispatchToMesh places the job on an eligible worker', async () => {
  const mesh = meshWith([{ id: 'a', engines: ['comfyui'] }], 90_000, Date.now());
  const fakeFetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
  const result = await dispatchToMesh(mesh, { engine: 'comfyui', task: 'video_render', payload: {} }, { fetchImpl: fakeFetch });
  assert.equal(result.ok, true);
  assert.equal(result.worker, 'a');
});

test('dispatch works over a real HTTP socket, with the bearer token', async () => {
  const http = await import('node:http');
  let received: { auth?: string; body?: any } = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received = { auth: req.headers.authorization as string, body: JSON.parse(raw || '{}') };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ video_url: 'http://worker/out.mp4', seconds: 10 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const mesh = new WorkerMesh();
  mesh.register(
    { id: 'real', url: `http://127.0.0.1:${port}`, token: 'tok', capabilities: { engines: ['comfyui'] } },
    Date.now(),
  );
  try {
    const result = await dispatchToMesh(mesh, { engine: 'comfyui', task: 'video_render', payload: { prompt: 'p' } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { video_url: 'http://worker/out.mp4', seconds: 10 });
    assert.equal(received.auth, 'Bearer tok');
    assert.equal(received.body.task, 'video_render');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('role defaults from capabilities: a GPU node is gpu, a plain node is cpu', () => {
  const mesh = new WorkerMesh();
  assert.equal(mesh.register({ id: 'g', url: 'http://g', capabilities: { gpu: 'RTX' } }, Date.now()).role, 'gpu');
  assert.equal(mesh.register({ id: 'c', url: 'http://c' }, Date.now()).role, 'cpu');
});

test('a phone is never handed heavy GPU work (Blocker G)', () => {
  const mesh = new WorkerMesh();
  // A phone that (wrongly) claims it can do comfyui still must not get it.
  mesh.register({ id: 'phone', url: 'http://p', role: 'phone' }, Date.now());
  assert.equal(mesh.select('comfyui', Date.now()), null);
  assert.equal(mesh.select('video_render', Date.now()), null);
  // Light CPU work is fine.
  assert.equal(mesh.select('ffmpeg', Date.now())?.id, 'phone');
});

test('a phone cannot relabel itself as a GPU node on re-register', () => {
  const mesh = new WorkerMesh();
  mesh.register({ id: 'phone', url: 'http://p', role: 'phone' }, Date.now());
  const again = mesh.register({ id: 'phone', url: 'http://p' }, Date.now());
  assert.equal(again.role, 'phone', 'the role sticks unless explicitly changed');
});

test('roleCanRun and isHeavyEngine are honest about what a phone can do', () => {
  assert.equal(roleCanRun('phone', 'ffmpeg'), true);
  assert.equal(roleCanRun('phone', 'comfyui'), false);
  assert.equal(roleCanRun('gpu', 'comfyui'), true);
  assert.equal(isHeavyEngine('SDXL'), true);
});

test('the summary counts phones', () => {
  const mesh = new WorkerMesh();
  mesh.register({ id: 'p1', url: 'http://p1', role: 'phone' }, Date.now());
  mesh.register({ id: 'g1', url: 'http://g1', capabilities: { gpu: 'X' } }, Date.now());
  assert.equal(mesh.summary(Date.now()).phones, 1);
});
