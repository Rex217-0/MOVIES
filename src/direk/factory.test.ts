import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeatureFactory, factorySummary } from './factory.ts';
import { FactoryDb } from './factoryDb.ts';
import { reviewAsset, listAssets } from './assets.ts';
import {
  originalityProvenance,
  ORIGINALITY_DECLARATION_UNGOUNDED,
} from './provenance.ts';
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
      return { data: Buffer.from(`scene-${index}`), seconds: FEATURE_SCENE_SECONDS, voiced: false, mediaClass: 'SYNTHETIC_MOTION' as const };
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
      return { data: Buffer.from(`scene-${index}`), seconds: FEATURE_SCENE_SECONDS, voiced: false, mediaClass: 'SYNTHETIC_MOTION' as const };
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
      return { data: Buffer.from(`scene-${index}`), seconds: FEATURE_SCENE_SECONDS, voiced: false, mediaClass: 'SYNTHETIC_MOTION' as const };
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

test('stitchMovie reads a film back from the database when memory was cleared', async () => {
  freshStore();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitchdb-'));
  const db = new FactoryDb(path.join(dbDir, 'factory.db'));
  const dbFactory = new FeatureFactory({
    renderScene: async ({ index }) => ({ data: Buffer.from(`scene-${index}`), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
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
    renderScene: async () => ({ data: Buffer.alloc(0), mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
    db,
  });
  const film = await cold.stitchMovie(job.id);
  assert.ok(film, 'the cold factory should rebuild the job from factory.db');
  assert.equal(film!.seconds, 2 * FEATURE_SCENE_SECONDS);
  db.close();
});


test('a MASTER job blocks a still-motion clip instead of stitching it', async () => {
  freshStore();
  let calls = 0;
  const factory = new FeatureFactory({
    // The free engine catches a missing ComfyUI in production; this stands in
    // for exactly that, so the factory sees a STILL_MOTION clip on a MASTER job.
    renderScene: async () => {
      calls += 1;
      return { data: Buffer.from('still'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'STILL_MOTION' as const };
    },
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
  });
  const job = factory.create({ brief: 'Isang pelikulang MASTER.', qualityTier: 'MASTER' });
  assert.equal(job.qualityTier, 'MASTER');
  factory.start(job.id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && job.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(job.status, 'done');
  // Every scene was blocked, not failed, and none became a rendered scene.
  assert.equal(job.blocked, FEATURE_SCENES);
  assert.equal(job.rendered, 0);
  assert.equal(job.failed, 0);
  for (const scene of job.scenes) {
    assert.equal(scene.status, 'blocked');
    assert.match(scene.blockedReason ?? '', /MASTER/);
    assert.match(scene.blockedReason ?? '', /STILL_MOTION/);
    assert.equal(scene.mediaClass, undefined, 'a blocked scene has no accepted media class');
  }
  // Nothing was written to the vault, so no still clip can be reviewed as a film.
  assert.equal(listAssets().length, 0);
  // No film was stitched from an empty, blocked set.
  assert.equal(job.film, undefined);
  assert.ok(calls >= FEATURE_SCENES);
});

test('a MASTER job accepts a synthetic render and records what it is', async () => {
  freshStore();
  const factory = new FeatureFactory({
    renderScene: async () => ({
      data: Buffer.from('render'), seconds: FEATURE_SCENE_SECONDS,
      mediaClass: 'SYNTHETIC_MOTION' as const, backend: 'comfyui',
    }),
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
  });
  const job = factory.create({ brief: 'Totoong render.', qualityTier: 'MASTER' });
  factory.start(job.id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && job.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(job.blocked, 0);
  assert.equal(job.rendered, FEATURE_SCENES);
  // The vault sidecar carries the provenance, so a review can tell what it is.
  const assets = listAssets();
  assert.equal(assets.length, FEATURE_SCENES);
  for (const asset of assets) {
    assert.equal(asset.mediaClass, 'SYNTHETIC_MOTION');
    assert.equal(asset.qualityTier, 'MASTER');
    assert.equal(asset.backend, 'comfyui');
    assert.ok(asset.checksum && asset.checksum.length === 64);
  }
});

test('a CANARY job still accepts the free still-motion engine', async () => {
  freshStore();
  const factory = new FeatureFactory({
    renderScene: async () => ({
      data: Buffer.from('still'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'STILL_MOTION' as const,
    }),
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
  });
  const job = factory.create({ brief: 'Mabilis na canary.' });
  // No tier given means CANARY, which proves the pipeline without a GPU.
  assert.equal(job.qualityTier, 'CANARY');
  factory.start(job.id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && job.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(job.blocked, 0);
  assert.equal(job.rendered, FEATURE_SCENES);
  assert.equal(listAssets().filter(a => a.mediaClass === 'STILL_MOTION').length, FEATURE_SCENES);
});

test('a re-render cannot smuggle a weaker clip past the tier', async () => {
  freshStore();
  let nextClass: 'SYNTHETIC_MOTION' | 'STILL_MOTION' = 'SYNTHETIC_MOTION';
  const factory = new FeatureFactory({
    renderScene: async () => ({
      data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: nextClass,
    }),
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
  });
  const job = factory.create({ brief: 'Re-render test.', qualityTier: 'MASTER' });
  factory.start(job.id);
  let deadline = Date.now() + 5000;
  while (Date.now() < deadline && job.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }
  const scene = job.scenes[0];
  assert.equal(scene.status, 'rendered');

  // The backend disappears; the free engine catches it. The re-render must block.
  nextClass = 'STILL_MOTION';
  await factory.rerender(job.id, scene.index);
  assert.equal(scene.status, 'blocked');
  assert.match(scene.blockedReason ?? '', /STILL_MOTION/);
  // The previously accepted asset is still on record; nothing weaker replaced it.
  assert.ok(scene.assetName, 'the earlier real render must not be deleted by a block');
});

test('the tier is persisted, so a restart cannot quietly downgrade the contract', async () => {
  freshStore();
  const db = new FactoryDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'f.db'));
  const factory = new FeatureFactory({
    renderScene: async () => ({
      data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const,
    }),
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
    db,
  });
  const job = factory.create({ brief: 'Persistensya.', qualityTier: 'MASTER' });
  factory.start(job.id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && job.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }
  const reloaded = db.load(job.id)!;
  assert.equal(reloaded.qualityTier, 'MASTER');
  assert.equal(reloaded.blocked, 0);
  assert.equal(reloaded.scenes[0].mediaClass, 'SYNTHETIC_MOTION');
  db.close();
});

test('a refusal that throws is still blocked, not a generic failure', async () => {
  freshStore();
  const factory = new FeatureFactory({
    // The real path throws instead of returning a refused class: no engine at
    // all is available for a MASTER job. That must read as blocked.
    renderScene: async () => {
      const error: any = new Error(
        'BLOCKED: REQUIRED_MASTER_BACKEND_UNAVAILABLE Ang MASTER job ay nangangailangan ng generative na render.',
      );
      error.code = 'REQUIRED_MASTER_BACKEND_UNAVAILABLE';
      error.name = 'MasterBackendBlocked';
      error.tier = 'MASTER';
      throw error;
    },
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
  });
  const job = factory.create({ brief: 'Walang GPU.', qualityTier: 'MASTER' });
  factory.start(job.id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && job.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(job.blocked, FEATURE_SCENES);
  assert.equal(job.failed, 0, 'a policy refusal must never be counted as a failure');
  assert.equal(job.rendered, 0);
  for (const scene of job.scenes) {
    assert.equal(scene.status, 'blocked');
    assert.equal(scene.stage, 'blocked');
    assert.match(scene.blockedReason ?? '', /REQUIRED_MASTER_BACKEND_UNAVAILABLE/);
  }
});

test('rerender turns a thrown refusal into blocked too', async () => {
  freshStore();
  let refuse = false;
  const factory = new FeatureFactory({
    renderScene: async () => {
      if (refuse) {
        const error: any = new Error('BLOCKED: REQUIRED_MASTER_BACKEND_UNAVAILABLE walang ComfyUI');
        error.code = 'REQUIRED_MASTER_BACKEND_UNAVAILABLE';
        throw error;
      }
      return { data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const };
    },
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
  });
  const job = factory.create({ brief: 'Rerender.', qualityTier: 'MASTER' });
  factory.start(job.id);
  let deadline = Date.now() + 5000;
  while (Date.now() < deadline && job.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }
  refuse = true;
  await factory.rerender(job.id, 1);
  assert.equal(job.scenes[0].status, 'blocked');
  assert.equal(job.blocked, 1);
  assert.equal(job.failed, 0);
  assert.ok(job.scenes[0].assetName, 'the earlier accepted asset stays on record');
});

// ---------------------------------------------------------------------------
// Provenance: what the factory writes down about each render.
// ---------------------------------------------------------------------------

test('a rendered scene records the facts the renderer reported', async () => {
  freshStore();
  const factory = new FeatureFactory({
    renderScene: async () => ({
      data: Buffer.from('scene'),
      seconds: FEATURE_SCENE_SECONDS,
      voiced: true,
      mediaClass: 'SYNTHETIC_MOTION' as const,
      backend: 'comfyui',
      seeds: [4242, 4343],
      render: { seed: 4242, width: 832, height: 480, frames: 49, workflow: 'wan.json' },
    }),
    ffmpegAvailable: async () => true,
  });
  const job = factory.create({ brief: 'Provenance test.' });
  factory.start(job.id);
  await settle(factory, job.id);

  const asset = listAssets().find(a => a.id === job.scenes[0].assetId)!;
  assert.equal(asset.backend, 'comfyui');
  assert.equal(asset.resolution, '832x480');
  assert.deepEqual(asset.seeds, [4242, 4343]);
  assert.equal(asset.seed, undefined, 'a cut has no single seed');
  assert.equal(asset.audioState, 'voiced');
  assert.equal(asset.mediaClass, 'SYNTHETIC_MOTION');
  assert.equal(asset.qualityTier, 'CANARY');
  assert.ok(asset.checksum && asset.checksum.length === 64);
  assert.ok(asset.promptHash && asset.promptHash.length === 64);
});

test('a renderer that reports nothing records no seed and no resolution', async () => {
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Walang facts.' });
  factory.start(job.id);
  await settle(factory, job.id);

  const asset = listAssets().find(a => a.id === job.scenes[0].assetId)!;
  assert.equal('seed' in asset, false);
  assert.equal(asset.resolution, undefined);
  assert.equal(asset.audioState, 'silent', 'the stand-in renderer said voiced: false');
});

test('a re-render supersedes the old asset and links the chain', async () => {
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Rerender chain.' });
  factory.start(job.id);
  await settle(factory, job.id);

  const first = job.scenes[2].assetId!;
  await factory.rerender(job.id, 3);
  const second = job.scenes[2].assetId!;
  assert.notEqual(first, second, 'a fresh asset was written');

  const old = listAssets().find(a => a.id === first)!;
  const fresh = listAssets().find(a => a.id === second)!;
  assert.equal(old.disposition, 'SUPERSEDED');
  assert.equal(old.replacementAssetId, second);
  assert.equal(fresh.parentAssetId, first);
});

test('only APPROVED_MASTER puts a scene in the film', async () => {
  freshStore();
  const { factory, concatCalls } = makeFactory();
  const job = factory.create({ brief: 'Disposition gating.' });
  factory.start(job.id);
  await settle(factory, job.id);

  const master = (i: number) => reviewAsset(job.scenes[i].assetId!, 'APPROVED_MASTER');
  master(0); master(1);
  factory.refresh(job.id);
  const film = await factory.assemble(job);
  assert.ok(film, 'two master-approved scenes are enough');
  assert.equal(concatCalls[0].length, 2);
});

test('a preview-only approval and a REFINE do not reach the film', async () => {
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Preview only.' });
  factory.start(job.id);
  await settle(factory, job.id);

  reviewAsset(job.scenes[0].assetId!, 'APPROVED_MASTER');
  reviewAsset(job.scenes[1].assetId!, 'APPROVED_PREVIEW_ONLY');
  reviewAsset(job.scenes[2].assetId!, 'REFINE');
  factory.refresh(job.id);

  assert.equal(job.scenes[0].status, 'approved');
  assert.equal(job.scenes[1].status, 'rendered', 'good enough to look at, not to ship');
  assert.equal(job.scenes[2].status, 'rendered', 'a refine asks for another render');
  assert.equal(job.approved, 1);
  assert.equal(await factory.assemble(job), undefined);
});

test('a technical rejection is a rejection, in the film and in the job view', async () => {
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Technical reject.' });
  factory.start(job.id);
  await settle(factory, job.id);

  reviewAsset(job.scenes[4].assetId!, 'REJECTED_TECHNICAL', { reason: 'Basag ang audio.' });
  factory.refresh(job.id);
  assert.equal(job.scenes[4].status, 'rejected');
  assert.equal(job.rejected, 1);
});

test('a superseded asset is not stitched even if it was once approved', async () => {
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Superseded.' });
  factory.start(job.id);
  await settle(factory, job.id);

  reviewAsset(job.scenes[0].assetId!, 'APPROVED_MASTER');
  reviewAsset(job.scenes[1].assetId!, 'APPROVED_MASTER');
  factory.refresh(job.id);
  assert.equal(job.approved, 2);

  await factory.rerender(job.id, 1);
  factory.refresh(job.id);
  const old = listAssets().find(a => a.disposition === 'SUPERSEDED')!;
  assert.ok(old, 'the replaced render was superseded by the rerender');
});

test('the stitched film records that it is an assembly, not a render', async () => {
  freshStore();
  const { factory } = makeFactory({ concatData: Buffer.from('film-bytes') });
  const job = factory.create({ brief: 'Film provenance.', qualityTier: 'MASTER' });
  factory.start(job.id);
  await settle(factory, job.id);
  reviewAsset(job.scenes[0].assetId!, 'APPROVED_MASTER');
  reviewAsset(job.scenes[1].assetId!, 'APPROVED_MASTER');
  factory.refresh(job.id);
  const film = await factory.assemble(job);
  assert.ok(film);

  const asset = listAssets().find(a => a.title.includes('buong pelikula'))!;
  assert.equal(asset.backend, 'ffmpeg-concat');
  assert.equal(asset.mediaClass, 'HYBRID');
  assert.equal(asset.qualityTier, 'MASTER');
  assert.equal('seed' in asset, false, 'an assembly has no seed of its own');
  assert.match(asset.modelOrWorkflowVersion!, /ffmpeg -c copy, 2 eksena/);
  assert.equal(asset.audioState, 'silent', 'the stand-in scenes are unvoiced');
});

test('a job carries its Section 7 declaration into every asset it makes', async () => {
  freshStore();
  const { factory } = makeFactory();
  const originality = originalityProvenance({
    genre: 'Drama', referenceCount: 6, usedFor: ['genre_benchmark'],
  });
  const job = factory.create({ brief: 'Section 7.', originality });
  assert.equal(job.originality.groundingUsed, true);
  factory.start(job.id);
  await settle(factory, job.id);

  const asset = listAssets().find(a => a.id === job.scenes[0].assetId)!;
  assert.equal(asset.originality?.groundingUsed, true);
  assert.equal(asset.originality?.groundingGenre, 'Drama');
  assert.equal(asset.originality?.referenceCount, 6);
});

test('a job created without a declaration claims no grounding', () => {
  freshStore();
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Walang declaration.' });
  assert.equal(job.originality.groundingUsed, false);
  assert.equal(job.originality.declaration, ORIGINALITY_DECLARATION_UNGOUNDED);
});

test('the declaration survives a save and load through SQLite', async () => {
  freshStore();
  const db = new FactoryDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factdb-')), 'factory.db'));
  const { factory } = makeFactory();
  const originality = originalityProvenance({ genre: 'Horror', referenceCount: 4 });
  const job = factory.create({ brief: 'Persist.', originality });
  db.save(job);
  const loaded = db.load(job.id)!;
  assert.equal(loaded.originality.groundingUsed, true);
  assert.equal(loaded.originality.groundingGenre, 'Horror');
  assert.equal(loaded.originality.referenceCount, 4);
});

test('a job row written before the declaration existed loads as ungrounded', async () => {
  freshStore();
  const db = new FactoryDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'factdb2-')), 'factory.db'));
  const { factory } = makeFactory();
  const job = factory.create({ brief: 'Legacy row.' });
  db.save(job);
  // Simulate a pre-migration row: the column exists but is NULL.
  (db as any).db.prepare('UPDATE movie_jobs SET originality = NULL WHERE id = ?').run(job.id);
  const loaded = db.load(job.id)!;
  assert.equal(loaded.originality.groundingUsed, false);
  assert.equal(loaded.originality.referenceCount, 0);
});

test('the scheduler survives a database error and hands the film back', async () => {
  // A "database is locked" thrown from the scheduler used to become an
  // unhandled rejection, and that killed the server mid-render. The film also
  // stayed `running` with a live lease, and START refuses to re-enter a running
  // film, so the UI sat at 0% until the lease expired. Both halves are checked
  // here: nothing escapes, and the film is claimable again straight away.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedlock-'));
  process.env.DIREK_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schedassets-'));
  process.env.DIREK_RENDERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'schedrenders-'));
  const db = new FactoryDb(path.join(dir, 'factory.db'));
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    db,
  });
  const job = factory.create({ brief: 'Isang horror sa gubat.' });

  const realClaim = db.claimNext.bind(db);
  let thrown = 0;
  db.claimNext = (() => {
    thrown++;
    // Not a lock error: a locked connection could not release the lease either.
    throw new Error('disk I/O error');
  }) as typeof db.claimNext;

  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    factory.start(job.id);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(thrown, 1, 'the scheduler should have tried to claim');
    assert.deepEqual(unhandled, [], 'the error must be caught, not left unhandled');

    // The failed run handed the film back instead of holding it.
    assert.equal(factory.get(job.id)!.status, 'paused');
    assert.equal(db.queue().filter(q => q.status === 'running').length, 0, 'the failed claim must be released');

    // And the same film can be started again, for real.
    db.claimNext = realClaim as typeof db.claimNext;
    factory.start(job.id);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && factory.get(job.id)!.status === 'running') {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.notEqual(factory.get(job.id)!.status, 'running');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    db.close();
  }
});

test('a fresh screenplay does not throw away the scenes already rendered', async () => {
  // START asks the Pilot for a new screenplay every time it is pressed, and that
  // breakdown used to rebuild the whole scene list as `pending`. A film that was
  // 60% rendered fell back to 0% and re-rendered what it already had — the bar
  // that appears to restart is worse than one that appears stuck.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breakdown-'));
  process.env.DIREK_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bdassets-'));
  process.env.DIREK_RENDERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bdrenders-'));
  const db = new FactoryDb(path.join(dir, 'factory.db'));
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    db,
  });
  const job = factory.create({ brief: 'Isang horror sa gubat.' });
  const first = job.scenes[0];
  first.status = 'rendered';
  first.stage = 'completed';
  first.percent = 100;
  first.assetId = 'AST-KEEP-ME';
  first.assetName = 'kept.mp4';
  factory.applyScript(job.id, 'script', { scenes: { scenes: [] } });

  const after = factory.get(job.id)!;
  assert.equal(after.scenes[0].status, 'rendered', 'a rendered scene must survive a new breakdown');
  assert.equal(after.scenes[0].assetId, 'AST-KEEP-ME');
  assert.equal(after.scenes[1].status, 'pending', 'an unrendered scene still takes the new text');
  db.close();
});
