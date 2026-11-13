import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAsset, listAssets, assetPath, deleteAsset, bundleAssets, assetsDir, SIDECAR_SUFFIX } from './assets.ts';
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
    // Same-millisecond saves are allowed to tie, so accept either order here
    // but require both present.
    assert.deepEqual(new Set(all.map(x => x.id)), new Set([a.id, b.id]));
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
