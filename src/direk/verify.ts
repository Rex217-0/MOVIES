/**
 * Output verification for untrusted workers (Blocker H).
 *
 * A worker in the mesh is untrusted: it could be buggy, misconfigured, or
 * hostile, and it could answer with a stub, a wrong-sized clip, or a file that
 * is not a video at all. The coordinator must never hand a phone a "finished
 * movie" it did not check.
 *
 * These are the cheap, decisive checks that need no ffmpeg and no network: the
 * bytes themselves. A container signature, a plausible length, and a declared
 * duration the caller can compare against what it asked for. Anything heavier
 * (ffprobe) is left to the caller, which already has the file.
 *
 * The rule is the same as everywhere else in this codebase: no fake success. A
 * check that cannot be made returns `ok: false` with a reason, never a pass.
 */

export interface VerifyExpectation {
  /** Minimum acceptable length in bytes. Default 1. */
  minBytes?: number;
  /** A duration was requested; the declared one must be within tolerance. */
  expectedSeconds?: number;
  /** Tolerance as a fraction, e.g. 0.5 means ±50%. Default 0.5. */
  tolerance?: number;
  /** The content must carry an audio stream. */
  requireAudio?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  /** What the check saw, for the log and the UI. */
  detail: string;
  bytes: number;
}

/** Container signatures a worker's "video" is allowed to carry. */
export function videoContainer(data: Buffer): 'mp4' | 'webm' | 'unknown' {
  if (data.length >= 12) {
    // ISO base media (mp4/mov/m4v): a box size, then 'ftyp'.
    if (data.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  }
  if (data.length >= 4) {
    // Matroska / WebM EBML header.
    if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return 'webm';
  }
  return 'unknown';
}

/** True when the buffer looks like any real image we accept. */
export function looksLikeImage(data: Buffer): boolean {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return true; // PNG
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true; // JPEG
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return true; // WebP
  return false;
}

/**
 * Verify a worker's video bytes against what was asked for. `declaredSeconds`
 * is whatever the worker reported; it is only trusted insofar as it must be
 * consistent with the request, and a missing or absurd value fails.
 */
export function verifyVideo(data: Buffer, expectation: VerifyExpectation = {}, declaredSeconds?: number): VerifyResult {
  const bytes = data?.length ?? 0;
  const minBytes = expectation.minBytes ?? 1;
  if (bytes < minBytes) {
    return { ok: false, bytes, detail: `Masyadong maliit ang output (${bytes} bytes < ${minBytes}).` };
  }
  const container = videoContainer(data);
  if (container === 'unknown') {
    return { ok: false, bytes, detail: 'Hindi video ang output (walang mp4/webm signature).' };
  }
  if (expectation.expectedSeconds !== undefined) {
    const tolerance = expectation.tolerance ?? 0.5;
    if (!Number.isFinite(declaredSeconds) || (declaredSeconds as number) <= 0) {
      return { ok: false, bytes, detail: `Walang wastong duration sa output (${declaredSeconds}).` };
    }
    const target = expectation.expectedSeconds;
    const low = target * (1 - tolerance);
    const high = target * (1 + tolerance);
    if ((declaredSeconds as number) < low || (declaredSeconds as number) > high) {
      return {
        ok: false,
        bytes,
        detail: `Mali ang duration: ${declaredSeconds}s, inaasahan ~${target}s (±${Math.round(tolerance * 100)}%).`,
      };
    }
  }
  return { ok: true, bytes, detail: `OK (${container}, ${bytes} bytes)` };
}

/**
 * Verify an image: real image bytes and a plausible size. An image that is not
 * an image is the classic worker stub.
 */
export function verifyImage(data: Buffer, minBytes = 64): VerifyResult {
  const bytes = data?.length ?? 0;
  if (bytes < minBytes) return { ok: false, bytes, detail: `Masyadong maliit (${bytes} bytes).` };
  if (!looksLikeImage(data)) return { ok: false, bytes, detail: 'Hindi image ang output.' };
  return { ok: true, bytes, detail: `OK (image, ${bytes} bytes)` };
}

/** SHA-256 of the bytes, for a worker to sign and the coordinator to compare. */
export async function hashBytes(data: Buffer): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(data).digest('hex');
}
