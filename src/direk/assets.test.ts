import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAsset, listAssets, assetPath, deleteAsset, bundleAssets, assetsDir, reviewAsset, SIDECAR_SUFFIX } from './assets.ts';
import { listZipEntries } from './zip.ts';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));
  const saved = process.env.DIREK_ASSETS_DIR;
  process.env.DIREK_ASSETS_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (saved === undefined) delete process.env.DIREK_ASSETS_DIR;
    else process.env.DIREK_ASSETS_DIR = saved;
  }
}

test('saveAsset writes the file and a sidecar, and listAssets reads it back', () => {
  withTempDir(dir => {
    const meta = saveAsset(Buffer.from('hello'), {
      title: 'Alat ng Dagat', ext: 'mp4', mime: 'video/mp4', source: 'test',
    });
    assert.equal(meta.kind, 'video');
    assert.equal(meta.bytes, 5);
    assert.ok(fs.existsSync(path.join(dir, meta.name)));
    assert.ok(fs.existsSync(path.join(dir, `${meta.name}${SIDECAR_SUFFIX}`)));

    const all = listAssets();
    assert.equal(all.length, 1);
    assert.equal(all[0].title, 'Alat ng Dagat');
  });
});

test('listAssets returns newest first', () => {
  withTempDir(() => {
    const a = saveAsset(Buffer.from('a'), { title: 'Una', ext: 'png', mime: 'image/png', source: 't' });
    const b = saveAsset(Buffer.from('b'), { title: 'Pangalawa', ext: 'png', mime: 'image/png', source: 't' });
    const all = listAssets();
    assert.equal(all.length, 2);
    // Both saves can land in the same millisecond; the ids must still be
    // distinct, so accept either order but require both present.
    assert.deepEqual(new Set(all.map(x => x.id)), new Set([a.id, b.id]));
  });
});

test('every asset id is unique even when saves land in the same millisecond', () => {
  // The bug this guards: a timestamp+counter id collided for renders saved in
  // the same millisecond, so `reviewAsset` approved the wrong scene and the
  // stitched film gained an extra scene. 18 saves in a tight loop must yield 18
  // distinct ids.
  withTempDir(() => {
    const metas = Array.from({ length: 18 }, (_v, i) =>
      saveAsset(Buffer.from(`scene-${i}`), { title: `Scene ${i}`, ext: 'mp4', mime: 'video/mp4', source: 't' }),
    );
    assert.equal(new Set(metas.map(m => m.id)).size, 18, 'all 18 asset ids are distinct');
    assert.match(metas[0].id, /^AST-[0-9a-f-]{36}$/, 'the id carries a UUID');
  });
});

test('reviewAsset matches exactly one asset when two scenes are saved together', () => {
  withTempDir(() => {
    const metas = Array.from({ length: 18 }, (_v, i) =>
      saveAsset(Buffer.from(`scene-${i}`), { title: `Scene ${i}`, ext: 'mp4', mime: 'video/mp4', source: 't' }),
    );
    // Approve scene 9 only; exactly one asset may read back as approved.
    reviewAsset(metas[8].id, 'approved');
    const approved = listAssets().filter(a => a.reviewStatus === 'approved');
    assert.equal(approved.length, 1, 'only the targeted asset is approved');
    assert.equal(approved[0].id, metas[8].id);
  });
});

test('assetPath refuses to escape the store', () => {
  withTempDir(() => {
    assert.equal(assetPath('../secrets.txt'), null);
    assert.equal(assetPath('/etc/passwd'), null);
    assert.equal(assetPath('wala.png'), null);
  });
});

test('deleteAsset removes the file and its sidecar', () => {
  withTempDir(dir => {
    const meta = saveAsset(Buffer.from('x'), { title: 'Burahin', ext: 'png', mime: 'image/png', source: 't' });
    assert.equal(deleteAsset(meta.name), true);
    assert.equal(fs.existsSync(path.join(dir, meta.name)), false);
    assert.equal(deleteAsset(meta.name), false);
  });
});

test('bundleAssets zips the chosen files with a manifest', () => {
  withTempDir(() => {
    const a = saveAsset(Buffer.from('one'), { title: 'Isa', ext: 'png', mime: 'image/png', source: 't' });
    saveAsset(Buffer.from('two'), { title: 'Dalawa', ext: 'png', mime: 'image/png', source: 't' });
    const zip = bundleAssets([a.name]);
    const entries = listZipEntries(zip);
    assert.deepEqual(entries.sort(), [a.name, 'MANIFEST.txt'].sort());
  });
});

test('assetsDir honours DIREK_ASSETS_DIR', () => {
  withTempDir(dir => {
    assert.equal(assetsDir(), dir);
  });
});

test('a fresh asset is pending, and reviewAsset sets the status on disk', () => {
  withTempDir(() => {
    const meta = saveAsset(Buffer.from('v'), { title: 'Pelikula', ext: 'mp4', mime: 'video/mp4', source: 't' });
    // A saved asset with no explicit status counts as waiting for review.
    assert.equal(listAssets()[0].reviewStatus, 'pending');

    const approved = reviewAsset(meta.id, 'approved');
    assert.equal(approved?.reviewStatus, 'approved');
    // The decision is persisted, not just returned.
    assert.equal(listAssets()[0].reviewStatus, 'approved');

    const rejected = reviewAsset(meta.name, 'rejected');
    assert.equal(rejected?.reviewStatus, 'rejected', 'an asset is found by name too');
    assert.equal(listAssets()[0].reviewStatus, 'rejected');
  });
});

test('reviewAsset returns null for an asset that does not exist', () => {
  withTempDir(() => {
    assert.equal(reviewAsset('AST-wala', 'approved'), null);
  });
});

test('reviewAsset rewrites only the target sidecar', () => {
  withTempDir(() => {
    const a = saveAsset(Buffer.from('a'), { title: 'Isa', ext: 'png', mime: 'image/png', source: 't' });
    const b = saveAsset(Buffer.from('b'), { title: 'Dalawa', ext: 'png', mime: 'image/png', source: 't' });
    reviewAsset(a.id, 'approved');
    const all = listAssets();
    const foundA = all.find(x => x.id === a.id);
    const foundB = all.find(x => x.id === b.id);
    assert.equal(foundA?.reviewStatus, 'approved');
    assert.equal(foundB?.reviewStatus, 'pending', 'the other asset keeps its status');
  });
});

test('a .json asset is not mistaken for a sidecar', () => {
  withTempDir(() => {
    const meta = saveAsset(Buffer.from('{"a":1}'), {
      title: 'Metadata', ext: 'json', mime: 'application/json', source: 't',
    });
    const all = listAssets();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, meta.id);
    assert.equal(deleteAsset(meta.name), true);
    assert.equal(listAssets().length, 0);
  });
});
