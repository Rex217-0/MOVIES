/**
 * Tests for the video quality gate.
 *
 * These run the real ffmpeg on real fixtures generated here, so the thresholds
 * are checked against actual pixels rather than mocked numbers. The point of the
 * gate is to reject rainbow noise and blank clips while keeping genuine footage,
 * so each case asserts that specific outcome.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ffmpegPath } from './render.ts';
import {
  BLANK_YDIF_LIMIT,
  FfmpegUnavailableError,
  NOISE_YDIF_LIMIT,
  checkVideoBuffer,
  checkVideoQuality,
  judgeVideo,
  measureVideo,
} from './videoQuality.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direk-qc-test-'));

function make(name: string, source: string): string {
  const file = path.join(dir, `${name}.mp4`);
  execFileSync(
    ffmpegPath(),
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source,
     '-pix_fmt', 'yuv420p', '-y', file],
    { stdio: 'ignore' },
  );
  return file;
}

const blank = make('blank', 'color=c=gray:s=128x128:d=2:r=8');
const moving = make('moving', 'testsrc2=s=128x128:d=2:r=8');
const noise = make(
  'noise',
  'nullsrc=s=128x128:d=2:r=8,geq=random(1)*255:random(2)*255:random(3)*255',
);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a blank clip is rejected, and the reason says it is blank', async () => {
  const verdict = await checkVideoQuality(blank);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /[Bb]lank/);
});

test('rainbow noise is rejected, and the reason points at the model, not the prompt', async () => {
  const verdict = await checkVideoQuality(noise);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /YDIF/);
  assert.match(verdict.reason, /checkpoint|sampler|model/i);
});

test('genuine moving footage passes', async () => {
  const verdict = await checkVideoQuality(moving);
  assert.equal(verdict.ok, true);
  assert.ok(verdict.metrics.ydif > BLANK_YDIF_LIMIT);
  assert.ok(verdict.metrics.ydif < NOISE_YDIF_LIMIT);
});

test('the measured separation is wide enough that the thresholds are not knife-edge', async () => {
  const good = await measureVideo(moving);
  const bad = await measureVideo(noise);
  const flat = await measureVideo(blank);

  // Real footage sits far below the limit and noise far above it. If a future
  // change makes these close, the limit needs revisiting rather than widening.
  assert.ok(good.ydif < NOISE_YDIF_LIMIT / 3, `real footage YDIF ${good.ydif} too close to the limit`);
  assert.ok(bad.ydif > NOISE_YDIF_LIMIT * 1.5, `noise YDIF ${bad.ydif} too close to the limit`);
  assert.equal(flat.ydif, 0, 'a still clip has no frame-to-frame change');
});

test('a one-frame clip is rejected instead of passing as a still image', () => {
  const verdict = judgeVideo({ ydif: 0, satavg: 50, frames: 1 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /frame/i);
});

test('a slow, still shot with colour is not mistaken for a blank clip', () => {
  // Barely any motion, but the frame has colour: legitimate, must pass.
  const verdict = judgeVideo({ ydif: 0.05, satavg: 40, frames: 10 });
  assert.equal(verdict.ok, true);
});

test('checkVideoBuffer measures a buffer without leaving temp files behind', async () => {
  const data = fs.readFileSync(moving);
  // Point TMPDIR at a private directory for this test so the assertion is not
  // disturbed by anything else on the machine, including parallel test files.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'direk-qc-isolated-'));
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = sandbox;
  try {
    const verdict = await checkVideoBuffer(data);
    assert.equal(verdict.ok, true);
    assert.deepEqual(fs.readdirSync(sandbox), [], 'temp dir was not cleaned up');
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('an empty buffer fails loudly instead of reporting a quality verdict', async () => {
  await assert.rejects(() => checkVideoBuffer(Buffer.alloc(0)), /Walang laman|ffmpeg|Invalid/i);
});

test('a missing file fails with a clear message', async () => {
  await assert.rejects(
    () => checkVideoQuality(path.join(dir, 'does-not-exist.mp4')),
    /Walang video/,
  );
});

test('a missing ffmpeg raises FfmpegUnavailableError, not a quality rejection', async () => {
  const data = fs.readFileSync(moving);
  const saved = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '/nonexistent/ffmpeg-binary-for-this-test';
  try {
    // The distinction matters: the caller must be able to tell "the tool is
    // missing" from "the video is garbage" and only fail on the latter.
    await assert.rejects(
      () => checkVideoBuffer(data),
      (error: unknown) => {
        assert.ok(error instanceof FfmpegUnavailableError, 'expected FfmpegUnavailableError');
        return true;
      },
    );
  } finally {
    if (saved === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = saved;
  }
});
