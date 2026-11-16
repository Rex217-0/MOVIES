import test from 'node:test';
import assert from 'node:assert/strict';
import {
  videoContainer, looksLikeImage, verifyVideo, verifyImage, hashBytes,
} from './verify.ts';

/** A minimal buffer with an mp4 'ftyp' box at offset 4. */
function fakeMp4(size = 2000): Buffer {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size, 0);
  b.write('ftyp', 4, 'ascii');
  return b;
}

function fakeWebm(size = 2000): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0x1a; b[1] = 0x45; b[2] = 0xdf; b[3] = 0xa3;
  return b;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);

test('containers are detected by signature, not by name', () => {
  assert.equal(videoContainer(fakeMp4()), 'mp4');
  assert.equal(videoContainer(fakeWebm()), 'webm');
  assert.equal(videoContainer(Buffer.from('hello world')), 'unknown');
});

test('a stub that is not a video is rejected', () => {
  const result = verifyVideo(Buffer.from('this is not a video'));
  assert.equal(result.ok, false);
  assert.match(result.detail, /Hindi video/);
});

test('an empty or tiny output is rejected', () => {
  assert.equal(verifyVideo(Buffer.alloc(0), { minBytes: 1000 }).ok, false);
  assert.match(verifyVideo(Buffer.alloc(10), { minBytes: 1000 }).detail, /Masyadong maliit/);
});

test('a real-looking mp4 with the right duration passes', () => {
  const result = verifyVideo(fakeMp4(), { expectedSeconds: 10 }, 10.5);
  assert.equal(result.ok, true);
});

test('a wrong duration fails and says why', () => {
  const result = verifyVideo(fakeMp4(), { expectedSeconds: 10 }, 1);
  assert.equal(result.ok, false);
  assert.match(result.detail, /Mali ang duration/);
});

test('a missing or absurd declared duration fails', () => {
  assert.equal(verifyVideo(fakeMp4(), { expectedSeconds: 10 }, undefined).ok, false);
  assert.equal(verifyVideo(fakeMp4(), { expectedSeconds: 10 }, 0).ok, false);
});

test('a duration within tolerance passes, just outside fails', () => {
  assert.equal(verifyVideo(fakeMp4(), { expectedSeconds: 10, tolerance: 0.5 }, 14.9).ok, true);
  assert.equal(verifyVideo(fakeMp4(), { expectedSeconds: 10, tolerance: 0.5 }, 15.1).ok, false);
});

test('images are checked for real image bytes', () => {
  assert.equal(looksLikeImage(PNG), true);
  assert.equal(looksLikeImage(JPEG), true);
  assert.equal(verifyImage(PNG).ok, true);
  assert.equal(verifyImage(Buffer.from('not an image at all')).ok, false);
});

test('hashBytes is stable and content-addressed', async () => {
  const a = await hashBytes(Buffer.from('x'));
  const b = await hashBytes(Buffer.from('x'));
  const c = await hashBytes(Buffer.from('y'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});
