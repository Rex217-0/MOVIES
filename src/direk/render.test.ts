import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPng, toPng, ffmpegPath } from './render.ts';

/** A 1x1 PNG, base64 — the smallest valid image the app ships in its tests. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Encode a real JPEG with the bundled ffmpeg, so the test needs no fixture. */
function makeJpeg(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pngtest-'));
  const out = path.join(dir, 'x.jpg');
  execFileSync(ffmpegPath(), [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=16x16',
    '-frames:v', '1', out,
  ]);
  const data = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return data;
}

test('isPng recognises the PNG signature and rejects other data', () => {
  assert.equal(isPng(PNG_1x1), true);
  assert.equal(isPng(Buffer.from('\xff\xd8\xff\xe0nope')), false);
  assert.equal(isPng(Buffer.alloc(0)), false);
  assert.equal(isPng(Buffer.from('short')), false);
});

test('toPng leaves a buffer that is already PNG untouched', async () => {
  const out = await toPng(PNG_1x1);
  assert.equal(out, PNG_1x1, 'the same buffer is returned, not a re-encode');
});

test('toPng re-encodes a JPEG into a real PNG', async () => {
  // This is the Pollinations case: it answers with a JPEG whatever the URL asks
  // for, and the app must store a real PNG under the .png name.
  const jpeg = makeJpeg();
  assert.equal(isPng(jpeg), false, 'the fixture must start as a JPEG');
  const png = await toPng(jpeg);
  assert.equal(isPng(png), true, 'the result must carry the PNG signature');
  assert.ok(png.length > 8);
});
