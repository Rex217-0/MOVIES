/**
 * Output quality gate for generated video.
 *
 * A broken render still comes back as a valid mp4: a wrong model, a mismatched
 * sampler, or a bad prompt can produce rainbow noise or a flat blank clip that
 * plays fine and looks like nothing. Downloading that to the user is worse than
 * failing, so every render is measured before it is accepted.
 *
 * Two signals from ffmpeg's own `signalstats`, both cheap and deterministic:
 *
 *   YDIF    mean absolute luma difference between consecutive frames. Real
 *           footage changes a little from frame to frame; noise changes wildly.
 *           Measured on generated fixtures: blank 0, testsrc2 ~7, rgb noise ~85.
 *   SATAVG  mean saturation. A flat clip sits at 0.
 *
 * Thresholds are deliberately loose. The gate exists to catch garbage, not to
 * judge art: a slow, still shot is a legitimate video and must pass.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath } from './render.ts';

/** Frame-to-frame luma change above this is noise, not motion. */
export const NOISE_YDIF_LIMIT = 40;

/** Below this, the clip is flat enough to be a blank frame. */
export const BLANK_YDIF_LIMIT = 0.15;

/** Below this mean saturation with no motion at all, it is a blank clip. */
export const BLANK_SAT_LIMIT = 1;

export interface VideoQuality {
  /** Mean absolute luma difference between consecutive frames. */
  ydif: number;
  /** Mean saturation across sampled frames. */
  satavg: number;
  /** Number of frames the measurement actually saw. */
  frames: number;
}

export type QualityVerdict =
  | { ok: true; metrics: VideoQuality }
  | { ok: false; reason: string; metrics: VideoQuality };

/**
 * Raised when the measurement itself could not run (no ffmpeg, unreadable
 * binary). This is deliberately distinct from a quality rejection: a broken
 * tool must not be reported as a broken video, and must not take video
 * generation down with it.
 */
export class FfmpegUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Hindi ma-measure ang video: ${cause instanceof Error ? cause.message : cause}`);
    this.name = 'FfmpegUnavailableError';
  }
}

/** Run ffmpeg and return both streams, since the metadata dump lands on stdout. */
function runFfmpeg(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { maxBuffer: 1 << 24, timeout }, (error, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      // ENOENT means the binary is not there at all; that is a tooling problem,
      // not a bad video, so it is surfaced as its own error type.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        reject(new FfmpegUnavailableError(error));
        return;
      }
      // ffmpeg exits non-zero on a null muxer run in some builds; the metadata
      // we want is already in the output, so only fail when there is none.
      if (error && !text.trim()) reject(error);
      else resolve(text);
    });
  });
}

/** Pull every value of `key=` out of the metadata dump, ignoring the 0th frame. */
function valuesOf(report: string, key: string): number[] {
  const pattern = new RegExp(`${key}=(-?[0-9.]+)`, 'g');
  const found: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(report)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/**
 * Measure a video file. Frames are resampled to 4 fps first, so the cost is
 * bounded by duration rather than by the source frame rate, and a very short
 * clip still yields several samples.
 */
export async function measureVideo(file: string, timeout = 120000): Promise<VideoQuality> {
  if (!fs.existsSync(file)) throw new Error(`Walang video sa ${file}`);
  if (!fs.statSync(file).size) throw new Error(`Walang laman ang video ${file}`);

  const report = await runFfmpeg(
    [
      '-hide_banner',
      '-i', file,
      '-vf', 'fps=4,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-',
      '-f', 'null',
      '-',
    ],
    timeout,
  );
  const satReport = await runFfmpeg(
    [
      '-hide_banner',
      '-i', file,
      '-vf', 'fps=4,signalstats,metadata=print:key=lavfi.signalstats.SATAVG:file=-',
      '-f', 'null',
      '-',
    ],
    timeout,
  );

  // YDIF's first frame is always 0 (nothing precedes it) and would drag the
  // mean down, so it is dropped.
  const ydif = valuesOf(report, 'YDIF').slice(1);
  const sat = valuesOf(satReport, 'SATAVG');

  return {
    ydif: ydif.length ? ydif.reduce((a, b) => a + b, 0) / ydif.length : 0,
    satavg: sat.length ? sat.reduce((a, b) => a + b, 0) / sat.length : 0,
    frames: sat.length,
  };
}

/** Decide whether a measured clip is worth showing to the user. */
export function judgeVideo(metrics: VideoQuality): QualityVerdict {
  if (metrics.frames < 2) {
    return {
      ok: false,
      reason:
        'Isang frame lang ang nabasa sa video — hindi ito gumagalaw. ' +
        'Tingnan ang frame count at ang VHS_VideoCombine node.',
      metrics,
    };
  }
  if (metrics.ydif > NOISE_YDIF_LIMIT) {
    return {
      ok: false,
      reason:
        `Basurang output: sobrang gulong frame-to-frame (YDIF ${metrics.ydif.toFixed(1)}, ` +
        `limit ${NOISE_YDIF_LIMIT}). Karaniwan itong senyales ng maling model o sampler, ` +
        'hindi ng prompt. Suriin ang COMFYUI_CHECKPOINT at ang steps/cfg ng workflow.',
      metrics,
    };
  }
  if (metrics.ydif < BLANK_YDIF_LIMIT && metrics.satavg < BLANK_SAT_LIMIT) {
    return {
      ok: false,
      reason:
        `Blankong output: walang galaw at walang kulay (YDIF ${metrics.ydif.toFixed(2)}, ` +
        `SATAVG ${metrics.satavg.toFixed(1)}). Karaniwang kulang ang weights o hindi ` +
        'natagpuan ang checkpoint.',
      metrics,
    };
  }
  return { ok: true, metrics };
}

/** Measure and judge in one call. Throws only when the file itself is unusable. */
export async function checkVideoQuality(file: string, timeout = 120000): Promise<QualityVerdict> {
  return judgeVideo(await measureVideo(file, timeout));
}

/** Write a buffer to a temp file, check it, then clean up. */
export async function checkVideoBuffer(
  data: Buffer,
  extension = '.mp4',
  timeout = 120000,
): Promise<QualityVerdict> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direk-qc-'));
  const file = path.join(dir, `clip${extension}`);
  try {
    fs.writeFileSync(file, data);
    return await checkVideoQuality(file, timeout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
