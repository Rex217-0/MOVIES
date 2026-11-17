import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeatureFactory, factorySummary } from './factory.ts';
import { FactoryDb } from './factoryDb.ts';
import { reviewAsset, listAssets } from './assets.ts';
import { listRenders } from './renderStore.ts';
import { FEATURE_SCENES, FEATURE_SCENE_SECONDS, FEATURE_TOTAL_SECONDS } from '../featureFilm.ts';

/** Every factory test writes to its own asset store and render store. */
function freshStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-'));
  process.env.DIREK_ASSETS_DIR = dir;
  process.env.DIREK_RENDERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'renders-'));
  return dir;
}

/** A factory with a stand-in renderer: no ffmpeg, no GPU. */
function makeFactory(overrides: {
  failOn?: number[];
  ffmpeg?: boolean;
  concatData?: Buffer;
} = {}) {
  const rendered: number[] = [];
  const attempts = new Map<number, number>();
  const concatCalls: string[][] = [];
  const factory = new FeatureFactory({
    renderScene: async ({ index }) => {
      rendered.push(index);
      const seen = (attempts.get(index) ?? 0) + 1;
      attempts.set(index, seen);
      // Fail only the first attempt, so a re-render can succeed.
      if (overrides.failOn?.includes(index) && seen === 1) throw new Error(`scene ${index} pumutok`);
      return { data: Buffer.from(`scene-${index}`), seconds: FEATURE_SCENE_SECONDS, voiced: false };
    },
    ffmpegAvailable: async () => overrides.ffmpeg ?? true,
    concat: async files => {
      concatCalls.push(files);
      return { data: overrides.concatData ?? Buffer.from(`joined:${files.length}`) };
    },
  });
  return { factory, rendered, concatCalls };
}

/** Wait until the batch settles: no longer running and nothing mid-render. */
async function settle(factory: FeatureFactory, id: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = factory.get(id)!;
    const rendering = job.scenes.some(s => s.status === 'rendering');
    if (job.status !== 'running' && !rendering) return job;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('batch did not settle');
}

test('create makes an 18-scene job from one brief, all pending', () => {
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Isang horror sa gubat, SPG.' });
  assert.equal(job.total, FEATURE_SCENES);
  assert.equal(job.scenes.length, 18);
  assert.equal(job.totalSeconds, FEATURE_TOTAL_SECONDS);
  assert.equal(job.status, 'idle');
  assert.ok(job.scenes.every(s => s.status === 'pending'));
  assert.equal(job.concept.rating, 'SPG');
  // Every scene is a heavy video, so it is routed T3.
  assert.ok(job.scenes.every(s => s.route.tier === 'T3'));
  assert.ok(factorySummary(job).includes(job.concept.title));
});

test('start renders all 18 scenes, one at a time, in order', async () => {
  freshStore();
  const { factory, rendered } = makeFactory();
  const job = factory.create({ brief: 'Isang aksyon sa Maynila.' });
  factory.start(job.id);
  const done = await settle(factory, job.id);

  assert.equal(done.status, 'done');
  assert.equal(done.rendered, 18);
  assert.equal(done.failed, 0);
  assert.equal(done.percent, 100);
  assert.equal(done.renderedSeconds, FEATURE_TOTAL_SECONDS);
  assert.deepEqual(rendered, Array.from({ length: 18 }, (_v, i) => i + 1));
  assert.ok(done.scenes.every(s => s.status === 'rendered' && s.assetName));
});

test('a scene reports its real pipeline stages as the renderer reaches them', async () => {
  freshStore();
  const seen: Record<number, string[]> = {};
  const factory = new FeatureFactory({
    renderScene: async ({ index, onStage }) => {
      seen[index] = [];
      for (const stage of ['scripting', 'rendering', 'audio', 'completed'] as const) {
        onStage?.(stage);
        seen[index].push(stage);
      }
      return { data: Buffer.from(`scene-${index}`), seconds: FEATURE_SCENE_SECONDS, voiced: false };
    },
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
  });
  const job = factory.create({ brief: 'Isang musikal sa Maynila.' });
  assert.ok(job.scenes.every(s => s.stage === 'scripting'), 'scenes start at scripting');
  factory.start(job.id);
  const done = await settle(factory, job.id);

  // Every scene ran through all four stages, in order, and ends completed.
  assert.deepEqual(seen[1], ['scripting', 'rendering', 'audio', 'completed']);
  assert.ok(done.scenes.every(s => s.stage === 'completed'));
});

test('a scene that fails is logged, skipped, and the batch continues', async () => {
  freshStore();
  const { factory, rendered } = makeFactory({ failOn: [3, 11] });
  const job = factory.create({ brief: 'Isang drama sa probinsya.' });
  factory.start(job.id);
  const done = await settle(factory, job.id);

  assert.equal(done.status, 'done');
  assert.equal(done.failed, 2);
  assert.equal(done.rendered, 16);
  assert.equal(done.scenes[2].status, 'failed');
  assert.match(done.scenes[2].error!, /pumutok/);
  assert.equal(done.scenes[10].status, 'failed');
  assert.equal(done.scenes[0].status, 'rendered');
  // It kept going to the end instead of stopping at the first failure.
  assert.equal(rendered.length, 18);
});

test('pause stops the batch; the scenes already done are kept', async () => {
  freshStore();
  let release: (() => void) | null = null;
  const factory = new FeatureFactory({
    renderScene: async ({ index }) => {
      if (index === 3) await new Promise<void>(r => { release = r; });
      return { data: Buffer.from(`scene-${index}`), seconds: FEATURE_SCENE_SECONDS, voiced: false };
    },
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
  });
  const job = factory.create({ brief: 'Isang thriller sa gabi.' });
  factory.start(job.id);
  // Wait until scene 3 is in flight, then pause.
  const deadline = Date.now() + 2000;
  while (!release && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.ok(release, 'scene 3 should have started');
  factory.pause(job.id);
  (release as unknown as () => void)();
  const after = await settle(factory, job.id);

  // A paused batch stops where it is; the scenes already done are kept.
  assert.equal(after.status, 'paused');
  assert.equal(after.rendered, 3);
  assert.equal(after.failed, 0);
  assert.ok(after.rendered < 18, 'pausing must leave the rest for later');
});

test('assemble stitches only the approved scenes, in order, with the copy path', async () => {
  freshStore();
  const { factory, concatCalls } = makeFactory({ concatData: Buffer.from('feature-bytes') });
  const job = factory.create({ brief: 'Isang romansa sa palengke.' });
  factory.start(job.id);
  await settle(factory, job.id);

  // Approve three scenes in the vault: 5, 2, and 17 (out of order on purpose).
  const approve = (index: number) => {
    const scene = job.scenes.find(s => s.index === index)!;
    reviewAsset(scene.assetId!, 'approved');
  };
  approve(5); approve(2); approve(17);
  factory.refresh(job.id);
  assert.equal(job.approved, 3);

  const film = await factory.assemble(job);
  assert.ok(film);
  assert.equal(film!.seconds, 3 * FEATURE_SCENE_SECONDS);
  assert.equal(concatCalls.length, 1);
  // The three files handed to ffmpeg are exactly the approved scenes, in order.
  const names = concatCalls[0].map(f => path.basename(f));
  assert.equal(names.length, 3);
  assert.match(names[0], /scene-2-/);
  assert.match(names[1], /scene-5-/);
  assert.match(names[2], /scene-17-/);
  // The stitched film was saved as an asset.
  const saved = listAssets().find(a => a.id && a.title.includes('buong pelikula'));
  assert.ok(saved, 'the stitched film should be in the vault');
});

test('assemble refuses fewer than two approved scenes', async () => {
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Isang komedya sa baryo.' });
  factory.start(job.id);
  await settle(factory, job.id);
  assert.equal(await factory.assemble(job), undefined);

  reviewAsset(job.scenes[0].assetId!, 'approved');
  factory.refresh(job.id);
  assert.equal(await factory.assemble(job), undefined, 'one scene is not a film');
});

test('assemble reports a missing ffmpeg instead of faking a film', async () => {
  freshStore();
  const { factory } = makeFactory({ ffmpeg: false });
  const job = factory.create({ brief: 'Isang dokumentaryo sa dagat.' });
  factory.start(job.id);
  await settle(factory, job.id);
  reviewAsset(job.scenes[0].assetId!, 'approved');
  reviewAsset(job.scenes[1].assetId!, 'approved');
  factory.refresh(job.id);
  await assert.rejects(() => factory.assemble(job), /ffmpeg/);
});

test('rerender re-renders a single failed scene without touching the others', async () => {
  freshStore();
  const { factory, rendered } = makeFactory({ failOn: [4] });
  const job = factory.create({ brief: 'Isang sci-fi sa Mars.' });
  factory.start(job.id);
  await settle(factory, job.id);
  assert.equal(job.scenes[3].status, 'failed');

  const before = rendered.length;
  const after = await factory.rerender(job.id, 4);
  assert.ok(after);
  assert.equal(after!.scenes[3].status, 'rendered');
  assert.equal(after!.scenes[3].error, undefined);
  assert.equal(rendered.length, before + 1, 'only one extra render');
  // The other scenes were not re-rendered.
  assert.equal(after!.rendered, 18);
});

test('refresh pulls the Staging Vault review decisions back into the job', async () => {
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Isang horror sa gubat.' });
  factory.start(job.id);
  await settle(factory, job.id);

  reviewAsset(job.scenes[0].assetId!, 'approved');
  reviewAsset(job.scenes[1].assetId!, 'rejected');
  factory.refresh(job.id);

  assert.equal(job.scenes[0].status, 'approved');
  assert.equal(job.scenes[1].status, 'rejected');
  assert.equal(job.approved, 1);
  assert.equal(job.rejected, 1);

  // Reverting the review returns the scene to "rendered".
  reviewAsset(job.scenes[1].assetId!, 'pending');
  factory.refresh(job.id);
  assert.equal(job.scenes[1].status, 'rendered');
});

test('every rendered scene is saved to the local render store as an .mp4', async () => {
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Isang aksyon sa Maynila.' });
  factory.start(job.id);
  const done = await settle(factory, job.id);

  // 18 scenes saved as .mp4 in the local render store. (No scene is approved
  // yet, so the batch does not stitch a film on its own.)
  const renders = listRenders();
  assert.equal(renders.length, 18, `expected 18 scene renders, got ${renders.length}`);
  assert.ok(renders.every(n => n.endsWith('.mp4')));
  // Each scene carries the public url the UI plays.
  assert.ok(done.scenes.every(s => s.renderUrl?.startsWith('/renders/')));
});

test('stitchMovie(id) gathers the approved scenes and joins them with -c copy', async () => {
  freshStore();
  const { factory, concatCalls } = makeFactory({ concatData: Buffer.from('stitched') });
  const job = factory.create({ brief: 'Isang drama sa probinsya.' });
  factory.start(job.id);
  await settle(factory, job.id);

  // Approve four scenes out of order.
  for (const i of [9, 1, 4, 15]) reviewAsset(job.scenes.find(s => s.index === i)!.assetId!, 'approved');

  // stitchMovie works from the id alone.
  const film = await factory.stitchMovie(job.id);
  assert.ok(film);
  assert.equal(film!.seconds, 4 * FEATURE_SCENE_SECONDS);
  assert.equal(concatCalls.length, 1);
  const names = concatCalls[0].map(f => path.basename(f));
  assert.deepEqual(
    names.map(n => Number(n.match(/scene-(\d+)-/)![1])),
    [1, 4, 9, 15],
    'the scenes handed to ffmpeg are approved and in order',
  );
});

test('assemble refuses to stitch two scenes that share one assetId', async () => {
  // A duplicate assetId means the review decision of one scene silently
  // approves another, so the film would gain a scene it never approved. The
  // guard must throw, not quietly count the scene twice.
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Isang drama sa probinsya.' });
  factory.start(job.id);
  await settle(factory, job.id);

  // Approve four scenes, then force two of them onto the same assetId, which is
  // what the id collision used to produce.
  for (const i of [1, 4, 9, 15]) reviewAsset(job.scenes.find(s => s.index === i)!.assetId!, 'approved');
  const view = factory.get(job.id)!;
  const dup = view.scenes.find(s => s.index === 4)!;
  const victim = view.scenes.find(s => s.index === 9)!;
  victim.assetId = dup.assetId;
  victim.assetName = dup.assetName;

  await assert.rejects(
    () => factory.stitchMovie(job.id),
    /Magkapareho ang asset/,
    'a shared assetId is refused instead of stitched',
  );
});

test('stitchMovie reads a film back from the database when memory was cleared', async () => {
  freshStore();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitchdb-'));
  const db = new FactoryDb(path.join(dbDir, 'factory.db'));
  const dbFactory = new FeatureFactory({
    renderScene: async ({ index }) => ({ data: Buffer.from(`scene-${index}`), seconds: FEATURE_SCENE_SECONDS }),
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
    db,
  });
  const job = dbFactory.create({ brief: 'Isang sci-fi sa Mars.' });
  dbFactory.start(job.id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && dbFactory.get(job.id)!.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }
  for (const i of [2, 3]) reviewAsset(job.scenes.find(s => s.index === i)!.assetId!, 'approved');
  dbFactory.refresh(job.id);

  // A fresh factory with an empty memory, same database: stitch still works.
  const cold = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.alloc(0) }),
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
    db,
  });
  const film = await cold.stitchMovie(job.id);
  assert.ok(film, 'the cold factory should rebuild the job from factory.db');
  assert.equal(film!.seconds, 2 * FEATURE_SCENE_SECONDS);
  db.close();
});

