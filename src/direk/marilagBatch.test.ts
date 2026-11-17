import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runMarilagBatch, newMarilagBatch, MARILAG_BATCH_NOTE,
  type BatchJobLike, type MarilagBatchDeps,
} from './marilagBatch.ts';
import { MARILAG_SCENES } from './marilag.ts';

/**
 * A tiny stand-in for the factory that mirrors the real shapes: a job starts
 * 'running', its scenes settle asynchronously, and stitch needs at least two
 * approved scenes. It lets the batch runner's ordering and honesty be tested
 * without a GPU.
 */
function fakeFactory(opts: { failMovies?: Set<number>; scenes?: number } = {}) {
  const scenes = opts.scenes ?? 3;
  const fail = opts.failMovies ?? new Set<number>();
  const jobs = new Map<string, BatchJobLike>();
  const approved: string[] = [];
  const order: string[] = [];
  let n = 0;

  const deps: MarilagBatchDeps = {
    createJob(concept) {
      const id = `FILM-${++n}`;
      order.push(concept.title!);
      const job: BatchJobLike = {
        id,
        status: 'idle',
        scenes: Array.from({ length: scenes }, (_, i) => ({ status: 'pending' })),
      };
      jobs.set(id, job);
      return { id };
    },
    startJob(id) {
      const job = jobs.get(id)!;
      job.status = 'running';
      const shouldFail = fail.has(n);
      // Settle asynchronously so the runner has to actually wait.
      setTimeout(() => {
        job.scenes.forEach((s, i) => {
          if (shouldFail) {
            s.status = 'failed';
            s.error = 'ComfyUI unreachable';
          } else {
            s.status = 'rendered';
            s.assetId = `AST-${id}-${i}`;
          }
        });
        job.status = 'done';
      }, 5);
    },
    getJob(id) {
      return jobs.get(id);
    },
    approveScene(assetId) {
      approved.push(assetId);
    },
    async stitch(id) {
      const job = jobs.get(id)!;
      const ok = job.scenes.filter(s => s.status === 'rendered').length;
      if (ok < 2) return undefined;
      return { assetName: `${id}.mp4`, bytes: 1000 * ok, seconds: ok * 300 };
    },
  };
  return { deps, approved, order, jobs };
}

test('the batch queues ten movies, all queued before it runs', () => {
  const batch = newMarilagBatch(() => 1000);
  assert.equal(batch.status, 'idle');
  assert.equal(batch.movies.length, 10);
  assert.ok(batch.movies.every(m => m.status === 'queued'));
  assert.equal(batch.movies[0].scenesTotal, MARILAG_SCENES);
});

test('the batch runs the ten movies one at a time, in order', async () => {
  const batch = newMarilagBatch();
  const { deps, order } = fakeFactory();
  batch.status = 'running';
  await runMarilagBatch(batch, deps);

  assert.equal(batch.status, 'done');
  assert.equal(order.length, 10);
  // Every movie is done, and the concepts were created in queue order.
  assert.ok(batch.movies.every(m => m.status === 'done'));
  assert.deepEqual(order, batch.movies.map(m => m.title));
});

test('every rendered scene is approved and the film is stitched', async () => {
  const batch = newMarilagBatch();
  const { deps, approved } = fakeFactory({ scenes: 4 });
  batch.status = 'running';
  await runMarilagBatch(batch, deps);

  // 10 movies x 4 scenes, each approved exactly once.
  assert.equal(approved.length, 40);
  assert.equal(new Set(approved).size, 40, 'no scene is approved twice');
  for (const m of batch.movies) {
    assert.equal(m.scenesRendered, 4);
    assert.equal(m.status, 'done');
    assert.equal(m.filmBytes, 4000);
    assert.ok(m.assetName);
  }
});

test('a movie that cannot render fails with its real reason and the batch continues', async () => {
  const batch = newMarilagBatch();
  // The 3rd movie (1-based) fails: no scene renders.
  const { deps } = fakeFactory({ failMovies: new Set([3]) });
  batch.status = 'running';
  await runMarilagBatch(batch, deps);

  assert.equal(batch.status, 'error', 'not every movie finished');
  assert.equal(batch.movies[2].status, 'failed');
  assert.match(batch.movies[2].error!, /ComfyUI unreachable/);
  // The movies before and after it still finished.
  assert.equal(batch.movies[0].status, 'done');
  assert.equal(batch.movies[1].status, 'done');
  assert.equal(batch.movies[3].status, 'done');
  assert.equal(batch.movies[9].status, 'done');
});

test('a failed movie is never stitched and never approved', async () => {
  const batch = newMarilagBatch();
  const { deps, approved } = fakeFactory({ failMovies: new Set([1]) });
  batch.status = 'running';
  await runMarilagBatch(batch, deps);

  assert.equal(batch.movies[0].status, 'failed');
  assert.equal(batch.movies[0].scenesRendered, 0);
  assert.equal(batch.movies[0].filmBytes, undefined);
  // Nine movies x 3 scenes; the failed movie contributed nothing.
  assert.equal(approved.length, 27);
});

test('the batch stops when it is no longer running', async () => {
  const batch = newMarilagBatch();
  const { deps, order } = fakeFactory();
  batch.status = 'running';
  // Flip to a non-running state before the runner starts.
  batch.status = 'idle';
  await runMarilagBatch(batch, deps);
  assert.equal(order.length, 0);
  assert.ok(batch.movies.every(m => m.status === 'queued'));
});

test('the batch note says plainly that nothing is published off-box', () => {
  assert.match(MARILAG_BATCH_NOTE, /CineStream|MyStream/);
  assert.match(MARILAG_BATCH_NOTE, /Hindi ito nag-publish|walang ipinadalang video/);
});
