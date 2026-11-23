/**
 * The Bodegero — the gatekeeper at the warehouse door.
 *
 * Every harvested image passes through here before it may join a LoRA dataset.
 * A bad sample is worse than a missing one: a corrupt file, a 200x200 thumbnail
 * or a 5000x400 panorama teaches the LoRA the wrong thing, and the damage only
 * shows up hours later in a ruined training run. So this module is deliberately
 * strict, and it always writes down why it turned something away.
 *
 * Three checks, in order of cost: is it a real PNG, is it big enough, is its
 * shape usable. Only then does it spend an AI call on the caption, and if that
 * call fails the image is still approved with a deterministic caption — an
 * offline Server-2 must still be able to build a dataset.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { generateTextWithFallback } from '../../services/aiRouter.ts';

/** Minimum width OR height for a training image. 720p means 720 on the short side. */
export const MIN_DIMENSION = 720;

/**
 * Widest and narrowest shapes allowed. Beyond 3:1 a LoRA learns a slice of a
 * scene rather than a scene; the training crops throw most of it away anyway.
 */
export const MAX_ASPECT = 3.0;
export const MIN_ASPECT = 1 / 3.0;

export interface QcDecision {
  passed: boolean;
  /** Short machine-readable code plus a human sentence. Always non-empty. */
  reason: string;
  /** Empty when rejected. Starts with the trigger token when approved. */
  cleanCaption: string;
  width?: number;
  height?: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read width and height straight out of the PNG IHDR chunk.
 *
 * Deliberately not trusting the extension or the Content-Type: a CDN that
 * answers 200 with an HTML error page saves as `.png` and looks fine on disk.
 * The IHDR sits at a fixed offset (signature 8 bytes, chunk length 4, type 4),
 * so this needs no image library. Returns null for anything that is not a PNG
 * with a readable header.
 */
export function getPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // Bytes 12-15 must spell IHDR; a PNG whose first chunk is anything else is broken.
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/** The caption used when the AI router is unavailable. Deterministic, no network. */
export function heuristicCaption(triggerToken: string, genre: string, theme: string): string {
  const parts = [
    triggerToken,
    `${genre} scene`,
    theme,
    'ultra high definition',
    '4k',
    'realistic cinematic lighting',
    'sharp focus',
  ];
  return parts.filter(Boolean).join(', ');
}

function sanitizeCaption(text: string, triggerToken: string, fallback: string): string {
  const cleaned = (text || '')
    .replace(/[\r\n"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  if (!cleaned) return fallback;
  // The trigger token must come first or the LoRA never binds to it.
  if (!cleaned.toLowerCase().startsWith(triggerToken.toLowerCase())) return fallback;
  return cleaned;
}

/**
 * Inspect one harvested image. Reads the file, checks it, and asks the router
 * for a caption. Never throws for a bad image — a rejection is a normal result,
 * not an error, so the harvester can keep going.
 */
export async function inspectImageWithBodegero(
  pngPath: string,
  triggerToken: string,
  genre: string,
  theme: string,
): Promise<QcDecision> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(pngPath);
  } catch (error: any) {
    return {
      passed: false,
      reason: `UNREADABLE: hindi mabasa ang file (${error?.code || error?.message || 'unknown'})`,
      cleanCaption: '',
    };
  }

  const dims = getPngDimensions(buf);
  if (!dims) {
    return {
      passed: false,
      reason: 'CORRUPT_NOT_PNG: invalid PNG header',
      cleanCaption: '',
    };
  }

  const { width, height } = dims;

  // Both sides must clear 720. A 1920x400 banner is wide enough but far too
  // short to train on, which is why this is `||` and not `&&`.
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
    return {
      passed: false,
      reason: `LOW_RES: ${width}x${height} is below the ${MIN_DIMENSION}px minimum on one side`,
      cleanCaption: '',
      width,
      height,
    };
  }

  const aspect = width / height;
  if (aspect > MAX_ASPECT || aspect < MIN_ASPECT) {
    return {
      passed: false,
      reason: `EXTREME_ASPECT: ${width}x${height} (${aspect.toFixed(2)}:1) unsuitable for LoRA training`,
      cleanCaption: '',
      width,
      height,
    };
  }

  const fallback = heuristicCaption(triggerToken, genre, theme);
  try {
    const prompt =
      `Write a single concise comma-separated Stable Diffusion / Flux LoRA training caption ` +
      `(max 35 words, no quotes, no newlines) starting with "${triggerToken}" for a ${genre} image ` +
      `with theme "${theme}". Focus on lighting, framing, and cinematic realism.`;
    const res = await generateTextWithFallback([{ role: 'user', content: prompt }]);
    return {
      passed: true,
      reason: `APPROVED (${width}x${height})`,
      cleanCaption: sanitizeCaption(res.text, triggerToken, fallback),
      width,
      height,
    };
  } catch {
    return {
      passed: true,
      reason: `APPROVED_OFFLINE_HEURISTIC (${width}x${height})`,
      cleanCaption: fallback,
      width,
      height,
    };
  }
}

/**
 * Move a rejected image out of the way and leave the reason beside it, so a
 * later look at `lora_rejected/` explains itself without digging through logs.
 */
export async function quarantineRejectedImage(
  pngPath: string,
  batchSlug: string,
  reason: string,
  rejectedRoot = path.join(process.cwd(), 'lora_rejected'),
): Promise<string> {
  const rejectedDir = path.join(rejectedRoot, batchSlug);
  await fs.mkdir(rejectedDir, { recursive: true });
  const fileName = path.basename(pngPath);
  const destPath = path.join(rejectedDir, fileName);

  try {
    await fs.rename(pngPath, destPath);
  } catch {
    // A rename across filesystems fails; copy then remove instead.
    await fs.copyFile(pngPath, destPath);
    await fs.unlink(pngPath).catch(() => {});
  }
  await fs.writeFile(`${destPath}.reason.txt`, reason, 'utf8');
  return destPath;
}
