import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveRender, renderPath, listRenders, renderUrl, rendersDir } from './renderStore.ts';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renderstore-'));
  const saved = process.env.DIREK_RENDERS_DIR;
  process.env.DIREK_RENDERS_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (saved === undefined) delete process.env.DIREK_RENDERS_DIR;
    else process.env.DIREK_RENDERS_DIR = saved;
  }
}

test('saveRender writes the .mp4 into the renders folder and returns its url', () => {
  withTempDir(dir => {
    const stored = saveRender(Buffer.from('video-bytes'), 'Ang Pelikula');
    assert.equal(stored.bytes, 11);
    assert.ok(stored.name.endsWith('.mp4'));
    assert.ok(stored.name.includes('ang-pelikula'));
    assert.ok(fs.existsSync(path.join(dir, stored.name)));
    assert.equal(stored.url, `/renders/${encodeURIComponent(stored.name)}`);
    assert.equal(stored.path, path.join(dir, stored.name));
  });
});

test('rendersDir honours DIREK_RENDERS_DIR', () => {
  withTempDir(dir => {
    assert.equal(rendersDir(), dir);
  });
});

test('renderPath resolves a stored file and refuses to escape the folder', () => {
  withTempDir(dir => {
    const stored = saveRender(Buffer.from('x'), 'Test');
    assert.equal(renderPath(stored.name), path.join(dir, stored.name));
    assert.equal(renderPath('wala.mp4'), null);
    assert.equal(renderPath('../escape.mp4'), null);
  });
});

test('listRenders returns only mp4 files', () => {
  withTempDir(() => {
    saveRender(Buffer.from('a'), 'Una');
    saveRender(Buffer.from('b'), 'Pangalawa');
    fs.writeFileSync(path.join(rendersDir(), 'notes.txt'), 'not a render');
    const names = listRenders();
    assert.equal(names.length, 2);
    assert.ok(names.every(n => n.endsWith('.mp4')));
  });
});
