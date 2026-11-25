import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FactoryDb } from './factoryDb.ts';
import { FeatureFactory, holderAlive } from './factory.ts';
import { FEATURE_SCENE_SECONDS } from '../featureFilm.ts';

function tmpDb(): FactoryDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorydb-'));
  return new FactoryDb(path.join(dir, 'factory.db'));
}

function tmpStore(): void {
  process.env.DIREK_ASSETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dbassets-'));
  process.env.DIREK_RENDERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrenders-'));
}

test('a created job is written to movie_jobs and its 18 scenes to scene_jobs', () => {
  tmpStore();
  const db = tmpDb();
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    db,
  });
  const job = factory.create({ brief: 'Isang horror sa gubat.' });

  assert.equal(db.count(), 1);
  assert.equal(db.sceneCount(job.id), 18);

  const loaded = db.load(job.id);
  assert.ok(loaded);
  assert.equal(loaded!.concept.title, job.concept.title);
  assert.equal(loaded!.scenes.length, 18);
  assert.equal(loaded!.status, 'idle');
  db.close();
});

test('the batch writes each scene status through to the database', async () => {
  tmpStore();
  const db = tmpDb();
  const factory = new FeatureFactory({
    renderScene: async ({ index }) => {
      if (index === 2) throw new Error('pumutok');
      return { data: Buffer.from(`s${index}`), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const };
    },
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
    db,
  });
  const job = factory.create({ brief: 'Isang aksyon sa Maynila.' });
  factory.start(job.id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && factory.get(job.id)!.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }

  // The database now reflects the finished batch, scene by scene.
  const loaded = db.load(job.id)!;
  assert.equal(loaded.rendered, 17);
  assert.equal(loaded.failed, 1);
  assert.equal(loaded.scenes[1].status, 'failed');
  assert.match(loaded.scenes[1].error!, /pumutok/);
  assert.equal(loaded.scenes[0].status, 'rendered');
  assert.equal(loaded.status, 'done');
  db.close();
});

test('load returns undefined for an unknown id, and list is newest-first', () => {
  tmpStore();
  const db = tmpDb();
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    db,
  });
  assert.equal(db.load('FILM-wala'), undefined);
  const a = factory.create({ brief: 'Una.' });
  const b = factory.create({ brief: 'Pangalawa.' });
  const listed = db.list();
  assert.equal(listed.length, 2);
  assert.ok(listed.some(j => j.id === a.id) && listed.some(j => j.id === b.id));
  db.close();
});

test('movieDoc carries the exact MovieJobs columns Copilot Firestore uses', () => {
  tmpStore();
  const db = tmpDb();
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    db,
  });
  const job = factory.create({ brief: 'Isang drama sa probinsya, SPG.' });

  const doc = db.movieDoc(job.id)!;
  assert.deepEqual(Object.keys(doc).sort(), [
    'created_at', 'format', 'genre', 'id', 'org_id', 'rating', 'status', 'title',
  ]);
  assert.equal(doc.id, job.id);
  assert.equal(doc.org_id, 'LJRgroupORG');
  assert.equal(doc.title, job.concept.title);
  assert.equal(doc.genre, job.concept.genre);
  assert.equal(doc.rating, job.concept.rating);
  assert.equal(doc.format, job.concept.format);
  assert.equal(doc.status, 'idle');
  assert.equal(typeof doc.created_at, 'number');
  assert.equal(doc.created_at, job.startedAt);
  assert.equal(db.movieDoc('FILM-wala'), undefined);
  db.close();
});

test('sceneDocs carries the exact SceneJobs columns, scene_number 1-18', () => {
  tmpStore();
  const db = tmpDb();
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    db,
  });
  const job = factory.create({ brief: 'Isang aksyon sa Maynila.' });

  const docs = db.sceneDocs(job.id);
  assert.equal(docs.length, 18);
  assert.deepEqual(Object.keys(docs[0]).sort(), [
    'id', 'movie_id', 'org_id', 'scene_number', 'status', 'video_path',
  ]);
  assert.ok(docs.every(d => d.org_id === 'LJRgroupORG'));
  assert.deepEqual(docs.map(d => d.scene_number), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.ok(docs.every(d => d.movie_id === job.id));
  assert.equal(docs[0].status, 'pending');
  assert.equal(docs[0].video_path, null);
  assert.equal(docs[0].id, `${job.id}-S01`);
  assert.equal(docs[17].id, `${job.id}-S18`);
  db.close();
});

test('a rendered scene writes its asset name into SceneJobs.video_path', async () => {
  tmpStore();
  const db = tmpDb();
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('scene'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
    db,
  });
  const job = factory.create({ brief: 'Isang horror sa gubat.' });
  factory.start(job.id);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && factory.get(job.id)!.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }

  const docs = db.sceneDocs(job.id);
  assert.equal(docs[0].status, 'rendered');
  assert.ok(docs[0].video_path && docs[0].video_path.endsWith('.mp4'), 'video_path points at the rendered mp4');
  db.close();
});

test('a database written before the alignment is migrated and backfilled', () => {
  tmpStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacydb-'));
  const file = path.join(dir, 'factory.db');

  // The old shape: no canonical columns, no script/bible.
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE movie_jobs (
      id TEXT PRIMARY KEY, concept TEXT NOT NULL, status TEXT NOT NULL, percent INTEGER NOT NULL DEFAULT 0,
      rendered INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 18, total_seconds INTEGER NOT NULL DEFAULT 5400,
      current_scene INTEGER NOT NULL DEFAULT 0, rendered_seconds INTEGER NOT NULL DEFAULT 0, film TEXT, error TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE scene_jobs (
      movie_id TEXT NOT NULL, idx INTEGER NOT NULL, act INTEGER NOT NULL, heading TEXT NOT NULL, beat TEXT NOT NULL,
      narration TEXT NOT NULL, visual TEXT NOT NULL, mood TEXT NOT NULL, status TEXT NOT NULL,
      percent INTEGER NOT NULL DEFAULT 0, seconds INTEGER NOT NULL DEFAULT 300, asset_id TEXT, asset_name TEXT,
      error TEXT, route TEXT NOT NULL, started_at INTEGER, ended_at INTEGER, PRIMARY KEY (movie_id, idx)
    );
    INSERT INTO movie_jobs (id, concept, status, started_at)
      VALUES ('FILM-old', '{"title":"Luma","genre":"drama","rating":"PG","format":"Realistic","brief":"x"}', 'idle', 1234);
    INSERT INTO scene_jobs (movie_id, idx, act, heading, beat, narration, visual, mood, status, route, asset_name)
      VALUES ('FILM-old', 1, 1, 'SCENE 1', 'beat', 'narration', 'visual', 'warm', 'rendered', '{}', 'old-scene.mp4');
  `);
  legacy.close();

  // Opening it with FactoryDb adds the columns and backfills them.
  const db = new FactoryDb(file);
  const doc = db.movieDoc('FILM-old')!;
  assert.equal(doc.org_id, 'LJRgroupORG', 'org_id backfilled onto a legacy row');
  assert.equal(doc.title, 'Luma');
  assert.equal(doc.genre, 'drama');
  assert.equal(doc.rating, 'PG');
  assert.equal(doc.format, 'Realistic');
  assert.equal(doc.created_at, 1234, 'created_at backfilled from started_at');

  const scenes = db.sceneDocs('FILM-old');
  assert.equal(scenes[0].org_id, 'LJRgroupORG', 'scene org_id backfilled too');
  assert.equal(scenes[0].scene_number, 1);
  assert.equal(scenes[0].id, 'FILM-old-S01');
  assert.equal(scenes[0].video_path, 'old-scene.mp4', 'video_path backfilled from asset_name');
  db.close();
});

test('every read is scoped to LJRgroupORG, so another org cannot leak in', () => {
  tmpStore();
  const db = tmpDb();
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    db,
  });
  const job = factory.create({ brief: 'Isang vault test.' });
  assert.equal(job.orgId, 'LJRgroupORG', 'a created job carries the vault id');

  // A film from a different org, written straight into the same database.
  const foreign = (db as unknown as { db: DatabaseSync }).db;
  foreign
    .prepare(
      `INSERT INTO movie_jobs (id, org_id, concept, status, started_at)
       VALUES ('FILM-ibang-org', 'IBANGORG', '{}', 'idle', 1)`,
    )
    .run();

  assert.equal(db.count(), 1, 'count() ignores the other org');
  assert.equal(db.load('FILM-ibang-org'), undefined, 'load() refuses the other org');
  assert.equal(db.movieDoc('FILM-ibang-org'), undefined, 'movieDoc() refuses the other org');
  assert.ok(db.list().every(j => j.id !== 'FILM-ibang-org'), 'list() never lists the other org');
  assert.ok(db.list().some(j => j.id === job.id), 'list() still returns our own film');
  db.close();
});

test('the factory serves only its own vault through get, latest and list', () => {
  tmpStore();
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
  });
  const ours = factory.create({ brief: 'Sa amin ito.' });

  // A job from another org injected straight into the in-memory map.
  const foreign = {
    ...ours,
    id: 'FILM-dayuhan',
    orgId: 'IBANGORG',
    startedAt: ours.startedAt + 1,
  };
  (factory as unknown as { jobs: Map<string, typeof ours> }).jobs.set(foreign.id, foreign);

  assert.equal(factory.get(foreign.id), undefined, 'get() refuses the other org');
  assert.equal(factory.latest()?.id, ours.id, 'latest() never returns the other org');
  assert.ok(factory.list().every(j => j.id !== foreign.id), 'list() never returns the other org');
  assert.deepEqual(factory.list().map(j => j.id), [ours.id]);
});

test('the shot plan survives a reload, so the UI can show the cut', () => {
  tmpStore();
  const db = tmpDb();
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
    db,
  });
  const job = factory.create({ brief: 'Shot plan.', qualityTier: 'MASTER' });
  const shots = [
    { index: 1, framing: 'establishing', seconds: 100 },
    { index: 2, framing: 'medium', seconds: 100 },
    { index: 3, framing: 'close', seconds: 100 },
  ];
  // The renderer reports the cut; save() is what writes it to SQLite.
  job.scenes[0].shots = shots;
  job.scenes[0].mediaClass = 'SYNTHETIC_MOTION';
  db.save(job);

  const reloaded = db.load(job.id);
  assert.ok(reloaded, 'the job came back');
  assert.deepEqual(reloaded!.scenes[0].shots, shots, 'the cut was not preserved');
  assert.equal(reloaded!.scenes[1].shots, undefined, 'a scene with no plan stays planless');
});

test('an older database gains shot_plan without losing its scenes', () => {
  tmpStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oldshot-'));
  const file = path.join(dir, 'factory.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE movie_jobs (
      id TEXT PRIMARY KEY, concept TEXT NOT NULL, status TEXT NOT NULL, percent INTEGER NOT NULL DEFAULT 0,
      rendered INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 18, total_seconds INTEGER NOT NULL DEFAULT 5400,
      current_scene INTEGER NOT NULL DEFAULT 0, rendered_seconds INTEGER NOT NULL DEFAULT 0, film TEXT, error TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE scene_jobs (
      movie_id TEXT NOT NULL, idx INTEGER NOT NULL, act INTEGER NOT NULL, heading TEXT NOT NULL, beat TEXT NOT NULL,
      narration TEXT NOT NULL, visual TEXT NOT NULL, mood TEXT NOT NULL, status TEXT NOT NULL,
      percent INTEGER NOT NULL DEFAULT 0, seconds INTEGER NOT NULL DEFAULT 300, asset_id TEXT, asset_name TEXT,
      error TEXT, route TEXT NOT NULL, started_at INTEGER, ended_at INTEGER, PRIMARY KEY (movie_id, idx)
    );
    INSERT INTO movie_jobs (id, concept, status, started_at)
      VALUES ('FILM-OLD', '{"title":"Luma","genre":"drama","rating":"PG","format":"Realistic","brief":"x"}', 'idle', 1234);
    INSERT INTO scene_jobs (movie_id, idx, act, heading, beat, narration, visual, mood, status, route)
      VALUES ('FILM-OLD', 1, 1, 'SCENE 1', 'beat', 'narration', 'visual', 'warm', 'rendered', '{}');
  `);
  legacy.close();

  const db = new FactoryDb(file);
  const job = db.load('FILM-OLD');
  assert.ok(job, 'the old job still loads');
  assert.equal(job!.scenes.length, 1);
  assert.equal(job!.scenes[0].heading, 'SCENE 1');
  assert.equal(job!.scenes[0].shots, undefined, 'a legacy scene has no plan, not an empty one');
});

test('accounting survives a save and load round-trip through SQLite', async () => {
  tmpStore();
  const db = tmpDb();
  const factory = new FeatureFactory({
    renderScene: async ({ index }) => ({
      data: Buffer.from(`s${index}-bytes`),
      seconds: FEATURE_SCENE_SECONDS,
      mediaClass: 'SYNTHETIC_MOTION' as const,
      backend: index === 1 ? 'comfyui' : 'stock',
      accounting: { renderDurationMs: 1000 * index, externalApiCalls: index },
    }),
    ffmpegAvailable: async () => true,
    concat: async files => ({ data: Buffer.from(`joined:${files.length}`) }),
    db,
  });

  const job = factory.create({ brief: 'Isang horror sa gubat.' });
  factory.start(job.id);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && factory.get(job.id)!.status === 'running') {
    await new Promise(r => setTimeout(r, 5));
  }

  const loaded = db.load(job.id)!;
  const first = loaded.scenes[0];
  assert.ok(first.accounting, 'the scene kept its accounting through SQLite');
  assert.equal(first.accounting!.renderDurationMs, 1000, 'measured duration, not a default');
  assert.equal(first.accounting!.externalApiCalls, 1);
  assert.deepEqual(first.accounting!.engines, ['comfyui']);
  assert.equal(first.accounting!.costBasis, 'NO_VENDOR_CALL_COST');
  assert.equal(first.accounting!.storageBytes, Buffer.byteLength('s1-bytes'));

  const second = loaded.scenes[1];
  assert.equal(second.accounting!.costBasis, 'THIRD_PARTY_FREE_TIER', 'stock is a vendor call, free tier');

  // The film-level rollup is persisted too, and it sums the scenes.
  assert.ok(loaded.accounting, 'the job kept its rollup');
  const sceneCalls = loaded.scenes.reduce((n, s) => n + (s.accounting?.externalApiCalls ?? 0), 0);
  assert.equal(loaded.accounting!.externalApiCalls, sceneCalls);
  assert.equal(loaded.accounting!.costBasis, 'THIRD_PARTY_FREE_TIER');
  db.close();
});

test('an old row without accounting loads with none claimed', () => {
  tmpStore();
  const db = tmpDb();
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    db,
  });
  const job = factory.create({ brief: 'Isang drama sa probinsya.' });
  const loaded = db.load(job.id)!;
  assert.equal(loaded.scenes[0].accounting, undefined, 'a pending scene has not spent anything yet');
  db.close();
});

test('the connection is configured to wait for a competing writer', () => {
  // Scene renders finish from more than one process against one file, and a bare
  // WAL connection throws SQLITE_BUSY instantly. `busy_timeout` is what turns
  // that into a wait, so it must be set on every connection this class opens.
  tmpStore();
  const db = tmpDb();
  const row = (db as any).db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
  assert.ok(row.timeout >= 1000, `busy_timeout was ${row.timeout}`);
  const journal = (db as any).db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  assert.equal(String(journal.journal_mode).toLowerCase(), 'wal');
  db.close();
});

test('releasing a failed holder makes the film claimable again at once', () => {
  // A batch that throws keeps its claim unless it is handed back, and START
  // refuses to re-enter a running film. Waiting for the lease to expire is the
  // "stuck at 0%" the operator sees; this is the release that avoids it.
  tmpStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  const db = new FactoryDb(path.join(dir, 'factory.db'));
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    db,
  });
  const job = factory.create({ brief: 'Isang horror sa gubat.' });
  db.enqueue(job.id);

  assert.equal(db.claimNext('dead-holder', { ttlMs: 60 * 60 * 1000 })?.movieId, job.id);
  assert.equal(db.claimScene(job.id, 1, 'dead-holder'), true);
  // The claim is live, so nobody else can have it yet.
  assert.equal(db.claimNext('next-holder', { ttlMs: 1000 }), undefined);

  assert.deepEqual(db.releaseHeld('dead-holder'), [job.id]);

  // The film is back in the queue, and the half-rendered shot is pending again
  // so it is re-rendered rather than skipped.
  assert.equal(db.claimNext('next-holder', { ttlMs: 1000 })?.movieId, job.id);
  assert.deepEqual(db.pendingScenes(job.id).includes(1), true);
  db.close();
});

test('a lease held by a dead process is recovered without waiting for the TTL', () => {
  // The TTL is 30 minutes because a real render can take that long, so a crash
  // left the film looking 'running' for half an hour with nothing rendering.
  // The holder carries its PID, so a dead one is recovered at once.
  tmpStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidrecover-'));
  const db = new FactoryDb(path.join(dir, 'factory.db'));
  const factory = new FeatureFactory({
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS, mediaClass: 'SYNTHETIC_MOTION' as const }),
    ffmpegAvailable: async () => true,
    db,
  });
  const job = factory.create({ brief: 'Isang horror sa gubat.' });
  db.enqueue(job.id);
  // A lease that is still inside its TTL, held by a process that is gone.
  assert.equal(db.claimNext('999999-deadbeef', { ttlMs: 60 * 60 * 1000 })?.movieId, job.id);

  const none = db.recoverAbandoned({ alive: () => true });
  assert.deepEqual(none, [], 'a live holder must keep its film');

  const recovered = db.recoverAbandoned({ alive: () => false });
  assert.deepEqual(recovered, [job.id], 'a dead holder must hand the film back at once');
  assert.equal(db.claimNext('next-holder', { ttlMs: 1000 })?.movieId, job.id);
  db.close();
});

test('holderAlive reads the PID out of both lease formats and rejects a zombie', () => {
  // A film lease is `pid-token`; a GPU lease is `label#pid-token`. Reading the
  // label as a PID reported every GPU holder as alive, which is what let a dead
  // render keep the device for the whole 30-minute TTL.
  assert.equal(holderAlive(`${process.pid}-abc123`), true);
  assert.equal(holderAlive(`film scene 5: "EKSENA 5"#${process.pid}-abc123`), true);
  assert.equal(holderAlive('999999-abc123'), false);
  assert.equal(holderAlive('film scene 5: "EKSENA 5"#999999-abc123'), false);
  // An unparseable holder is treated as alive: better to wait than to steal a
  // lease from a process we cannot identify.
  assert.equal(holderAlive('weird'), true);
});
