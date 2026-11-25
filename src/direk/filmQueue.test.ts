import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FactoryDb } from './factoryDb.ts';
import { FeatureFactory } from './factory.ts';
import { FEATURE_SCENE_SECONDS } from '../featureFilm.ts';

function tmpDb(): { db: FactoryDb; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'factory.db');
  return { db: new FactoryDb(file), file };
}

function tmpStore(): void {
  process.env.DIREK_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-assets-'));
  process.env.DIREK_RENDERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-renders-'));
}

function makeFactory(db: FactoryDb, opts: { onScene?: (i: number) => void } = {}): FeatureFactory {
  return new FeatureFactory({
    renderScene: async ({ index }) => {
      opts.onScene?.(index);
      return { data: Buffer.from(`scene-${index}`), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const };
    },
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
    db,
  });
}

async function settle(factory: FeatureFactory, id: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = factory.get(id);
    if (job && job.status !== 'running' && !job.scenes.some(s => s.status === 'rendering')) return job;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('batch did not settle');
}

test('START puts the film in the ledger and the claim is what runs it', async () => {
  tmpStore();
  const { db } = tmpDb();
  const factory = makeFactory(db);
  const job = factory.create({ brief: 'Isang pelikulang pang-adbentura.' });
  factory.start(job.id);

  const row = db.queue().find(r => r.movieId === job.id);
  assert.ok(row, 'START must write a queue row');
  assert.ok(['running', 'done'].includes(row!.status));

  const done = await settle(factory, job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.rendered, 18);
  db.close();
});

test('pressing START twice does not run two batches over the same film', async () => {
  tmpStore();
  const { db } = tmpDb();
  const rendered: number[] = [];
  const factory = makeFactory(db, { onScene: i => rendered.push(i) });
  const job = factory.create({ brief: 'Isang comedy sa baryo.' });

  factory.start(job.id);
  factory.start(job.id);
  factory.start(job.id);

  const done = await settle(factory, job.id);
  assert.equal(done.rendered, 18);
  // Each scene rendered exactly once even though START was pressed three times.
  assert.equal(rendered.length, 18);
  assert.equal(new Set(rendered).size, 18);
  db.close();
});

test('a second film waits its turn instead of interleaving with the first', async () => {
  tmpStore();
  const { db } = tmpDb();
  const events: string[] = [];
  const factory = makeFactory(db, { onScene: () => {} });
  const first = factory.create({ brief: 'Pelikula isa.' });
  const second = factory.create({ brief: 'Pelikula dalawa.' });

  const original = factory['deps'].renderScene;
  factory['deps'].renderScene = async input => {
    events.push(`${input.index}`);
    return original(input);
  };

  factory.start(first.id);
  factory.start(second.id);
  await settle(factory, first.id);
  await settle(factory, second.id);

  // Scene numbers must arrive as two contiguous runs (1..18 then 1..18), never
  // interleaved: that is what "concurrency = 1" means for the film queue.
  const runs: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (i === 0 || Number(events[i]) < Number(events[i - 1])) runs.push(i);
  }
  assert.equal(runs.length, 2, `expected two contiguous runs, got events: ${events.join(',')}`);
  db.close();
});

test('a crash mid-scene is recovered: the unfinished scene is pending again and the film is paused', async () => {
  tmpStore();
  const { db, file } = tmpDb();

  // Simulate a process that died mid-render: a running queue row whose lease has
  // expired, a film left 'running', and one scene stuck at 'rendering'.
  const crashed = makeFactory(db);
  const job = crashed.create({ brief: 'Isang pelikulang naputol.' });
  db.enqueue(job.id, { holder: 'dead-process' });
  const claimed = db.claimNext('dead-process', { ttlMs: 1 });
  assert.equal(claimed?.movieId, job.id);
  assert.ok(db.claimScene(job.id, 3, 'dead-process', { ttlMs: 1 }));
  db.save({ ...crashed.get(job.id)!, status: 'running' });

  // A new process opens the same database and recovers.
  const reopened = new FactoryDb(file);
  const fresh = makeFactory(reopened);
  const recovered = fresh.recover();

  assert.deepEqual(recovered, [job.id]);
  const row = reopened.queue().find(r => r.movieId === job.id);
  assert.equal(row?.status, 'queued', 'the interrupted film must be claimable again');
  const film = reopened.load(job.id)!;
  assert.equal(film.status, 'paused');
  assert.equal(film.scenes.find(s => s.index === 3)?.status, 'pending', 'the stranded scene must be retryable');
  db.close();
  reopened.close();
});

test('recovery leaves a live lease alone', async () => {
  tmpStore();
  const { db } = tmpDb();
  const factory = makeFactory(db);
  const job = factory.create({ brief: 'Pelikulang tumatakbo pa.' });
  db.enqueue(job.id, { holder: 'live' });
  db.claimNext('live', { ttlMs: 60_000 });
  db.save({ ...factory.get(job.id)!, status: 'running' });

  // A second process must not steal work that is still being renewed.
  const recovered = factory.recover();
  assert.deepEqual(recovered, []);
  assert.equal(db.queue().find(r => r.movieId === job.id)?.status, 'running');
  db.close();
});

test('a pause stops the batch and keeps the scenes already rendered', async () => {
  tmpStore();
  const { db } = tmpDb();
  let scenes = 0;
  // Pause from inside the renderer, so the test does not depend on how fast the
  // batch happens to run: the third scene finishes, then nothing new starts.
  const factory: FeatureFactory = new FeatureFactory({
    renderScene: async ({ index }) => {
      scenes += 1;
      if (index === 3) factory.pause(jobRef.id);
      return { data: Buffer.from(`s${index}`), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const };
    },
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`j:${files.length}`) }),
    db,
  });

  const job = factory.create({ brief: 'Pelikula na pahihintuin.' });
  const jobRef = job;
  factory.start(job.id);

  const settled = await settle(factory, job.id);
  assert.equal(settled.status, 'paused');
  assert.equal(scenes, 3, `the batch must stop after the scene in flight, ran ${scenes}`);
  assert.equal(settled.rendered, 3);
  db.close();
});

test('START after a finished film runs it again from the scenes still missing', async () => {
  tmpStore();
  const { db } = tmpDb();
  const factory = makeFactory(db);
  const job = factory.create({ brief: 'Pelikulang uulitin.' });

  factory.start(job.id);
  await settle(factory, job.id);
  assert.equal(factory.get(job.id)!.rendered, 18);

  // A finished film is requeued deliberately, so a re-run is possible rather
  // than silently ignored.
  factory.start(job.id);
  const again = await settle(factory, job.id);
  assert.equal(again.status, 'done');
  assert.equal(again.rendered, 18);
  db.close();
});

test('the ledger never reports more than one film running', async () => {
  tmpStore();
  const { db } = tmpDb();
  const factory = makeFactory(db);
  const jobs = [1, 2, 3].map(n => factory.create({ brief: `Pelikula ${n}.` }));

  for (const j of jobs) factory.start(j.id);

  let sawRunning = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const running = db.queue().filter(r => r.status === 'running').length;
    sawRunning = Math.max(sawRunning, running);
    if (jobs.every(j => factory.get(j.id)!.status === 'done')) break;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(sawRunning, 1, 'concurrency must be exactly 1');
  for (const j of jobs) assert.equal(factory.get(j.id)!.status, 'done');
  db.close();
});
