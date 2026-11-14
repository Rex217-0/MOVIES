import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPng, toPng, ffmpegPath, concatCopy, probe, filterPath, concatListPath } from './render.ts';

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

test('concatCopy stitches clips with -c copy and preserves their total length', async () => {
  // Two short clips with identical codec/size/audio layout, the way
  // renderFeatureScene produces every scene, must join without a re-encode.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-'));
  const clip = (name: string, seconds: number, color: string) => {
    const out = path.join(dir, name);
    execFileSync(ffmpegPath(), [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=30:d=${seconds}`,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-t', String(seconds), out,
    ]);
    return out;
  };
  const a = clip('a.mp4', 1, 'red');
  const b = clip('b.mp4', 2, 'blue');

  const joined = await concatCopy([a, b]);
  assert.equal(joined.ext, 'mp4');
  assert.equal(joined.mime, 'video/mp4');

  const outFile = path.join(dir, 'joined.mp4');
  fs.writeFileSync(outFile, joined.data);
  const info = await probe(outFile);
  assert.ok(Math.abs(info.duration - 3) < 0.5, `expected ~3s, got ${info.duration}`);
  assert.equal(info.hasAudio, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('concatCopy needs at least two clips', async () => {
  await assert.rejects(() => concatCopy(['one.mp4']), /dalawa/);
});

test('filterPath escapes the characters that break an ffmpeg filtergraph', () => {
  // An unescaped drive colon makes ffmpeg read the value as a key/value pair
  // ("Both text and text file provided"), and backslashes start escapes.
  assert.equal(filterPath('C:\\Users\\rex\\font.ttf'), 'C\\:\\\\Users\\\\rex\\\\font.ttf');
  assert.equal(filterPath('/usr/share/fonts/a.ttf'), '/usr/share/fonts/a.ttf');
  assert.equal(filterPath("a'b.ttf"), "a\\'b.ttf");
});

test('concatListPath turns a Windows path into a forward-slash path', () => {
  // The concat demuxer treats `\` as an escape, so `C:\...\clip.mp4` fails with
  // "Impossible to open". Forward slashes work on every platform.
  assert.equal(concatListPath('C:\\renders\\scene-1.mp4'), 'C:/renders/scene-1.mp4');
  assert.equal(concatListPath('/tmp/renders/scene-1.mp4'), '/tmp/renders/scene-1.mp4');
  assert.equal(concatListPath("/tmp/a'b.mp4"), "/tmp/a'\\''b.mp4");
});

test('concatCopy joins clips whose list entries use forward slashes', async () => {
  // Emulates the Windows case: the file paths the factory holds contain
  // backslashes, and concatCopy must normalise them before ffmpeg reads them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concatwin-'));
  const clip = (name: string, color: string) => {
    const out = path.join(dir, name);
    execFileSync(ffmpegPath(), [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=30:d=1`,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-t', '1', out,
    ]);
    // Hand back a backslash-separated path, exactly as a Windows build would.
    return out.replace(/\//g, '\\');
  };
  const joined = await concatCopy([clip('a.mp4', 'red'), clip('b.mp4', 'blue')]);
  assert.equal(joined.ext, 'mp4');
  fs.rmSync(dir, { recursive: true, force: true });
});
