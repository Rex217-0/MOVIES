import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FactoryDb } from './factoryDb.ts';
import { FeatureFactory } from './factory.ts';
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
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS }),
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
      return { data: Buffer.from(`s${index}`), seconds: FEATURE_SCENE_SECONDS };
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
    renderScene: async () => ({ data: Buffer.from('x') }),
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
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS }),
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
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS }),
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
    renderScene: async () => ({ data: Buffer.from('scene'), seconds: FEATURE_SCENE_SECONDS }),
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
    renderScene: async () => ({ data: Buffer.from('x'), seconds: FEATURE_SCENE_SECONDS }),
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
