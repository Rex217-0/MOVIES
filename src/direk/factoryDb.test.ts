import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
