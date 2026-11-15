/**
 * The video render pipeline: a raw clip is generated, then optionally edited
 * before it is saved to the Render Vault.
 *
 * Generation order is set by the PREFERRED_RENDER_ENGINE switch:
 *   PREFERRED_RENDER_ENGINE=fal      Cloud-first: route straight to Wan 2.2 on
 *                                    fal.ai and do NOT ping ComfyUI.
 *   PREFERRED_RENDER_ENGINE=comfyui  Local-first: try the local ComfyUI
 *                                    (Server-2 GPU) first, then Wan 2.2 on
 *                                    fal.ai.
 *   PREFERRED_RENDER_ENGINE=motion   No cost: a real clip from a free image
 *                                    backend (ComfyUI, else Pollinations, which
 *                                    needs no key and no GPU) animated with
 *                                    ffmpeg. No cloud spend, no account.
 * Unset defaults to `fal`, so the factory is cloud-first until ComfyUI is live
 * on Server-2.
 *
 * Editing is an optional post-process on a finished clip:
 *   OpenCut on fal.ai — cuts, transitions and colour grading.
 *
 * When nothing can render, this throws `VideoBackendUnavailable`. The API turns
 * that into a 503 `AI_UNAVAILABLE`. A placeholder clip is never returned.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { comfyAvailable, comfyVideoConfigured, generateVideoWithComfy } from './comfyui.ts';
import { imagine } from './imagine.ts';
import { imageToVideo } from './render.ts';
import {
  falKeyConfigured, openCutConfigured, wanConfigured, wanEndpoint,
  generateVideoWithWan, editWithOpenCut, uploadToFal,
} from './fal.ts';

export class VideoBackendUnavailable extends Error {
  readonly code = 'AI_UNAVAILABLE';
  constructor(detail: string) {
    super(`Walang video backend: ${detail}`);
    this.name = 'VideoBackendUnavailable';
  }
}

/** Which engine the pipeline prefers as primary. */
export type PreferredRenderEngine = 'fal' | 'comfyui' | 'motion';

/**
 * The PREFERRED_RENDER_ENGINE master switch. Cloud-first by default: an unset
 * or unrecognised value means `fal`.
 */
export function preferredRenderEngine(): PreferredRenderEngine {
  const raw = (process.env.PREFERRED_RENDER_ENGINE || 'fal').trim().toLowerCase();
  if (raw === 'comfyui' || raw === 'comfy' || raw === 'local') return 'comfyui';
  if (raw === 'motion' || raw === 'free' || raw === 'nocost') return 'motion';
  return 'fal';
}

export interface VideoRenderInput {
  prompt: string;
  negative?: string;
  aspectRatio?: string;
  resolution?: string;
  /** Target clip length in seconds; the free motion engine honours it. */
  seconds?: number;
  /** Optional editing instructions; when set, OpenCut runs on the raw clip. */
  editInstructions?: string;
}

export interface VideoRenderResult {
  data: Buffer;
  /** Which engine produced the clip: `comfyui`, `wan`, or the free `motion`. */
  engine: 'comfyui' | 'wan' | 'motion';
  /** Which engine edited it, when the editing pass ran. */
  editor?: 'opencut';
  /** A short human-readable note about the editing pass, for the logs. */
  editNote?: string;
}

/** True when a real local ComfyUI video backend can render right now. */
export async function comfyVideoReady(): Promise<boolean> {
  if (process.env.COMFYUI_DISABLE === '1') return false;
  if (!comfyVideoConfigured()) return false;
  return comfyAvailable();
}

/**
 * True when the free motion engine can render right now. It needs an image
 * backend (local ComfyUI, else Pollinations, which needs no key and no GPU) and
 * the ffmpeg that ships with the app.
 */
export async function motionReady(): Promise<boolean> {
  if (process.env.MOTION_DISABLE === '1') return false;
  const { imageBackend } = await import('./imagine.ts');
  return (await imageBackend()) !== 'none';
}

/** Why the local ComfyUI video backend is not ready, for an honest message. */
export function comfyVideoDetail(): string {
  if (process.env.COMFYUI_DISABLE === '1') return 'COMFYUI_DISABLE=1';
  if (!comfyVideoConfigured()) {
    return 'walang COMFYUI_VIDEO_WORKFLOW (kailangan ng AnimateDiff/SVD workflow sa API format)';
  }
  return 'hindi maabot ang ComfyUI sa http://127.0.0.1:8188';
}

/**
 * True when the preferred engine can render right now. Cloud-first (fal) needs
 * only FAL_KEY; local-first (comfyui) also accepts Wan 2.2 as a fallback; the
 * no-cost motion engine needs only a free image backend.
 */
export async function videoRenderReady(): Promise<boolean> {
  if (preferredRenderEngine() === 'fal') return wanConfigured();
  if (preferredRenderEngine() === 'motion') return motionReady();
  return (await comfyVideoReady()) || wanConfigured();
}

/** Why no video engine can render, for an honest error message. */
export async function videoRenderDetail(): Promise<string> {
  const preferred = preferredRenderEngine();
  if (preferred === 'fal') {
    return `PREFERRED_RENDER_ENGINE=fal: kailangan ng FAL_KEY para sa Wan 2.2 (${wanEndpoint()})`;
  }
  if (preferred === 'motion') {
    const { imageBackend } = await import('./imagine.ts');
    const backend = await imageBackend();
    return backend === 'none'
      ? 'PREFERRED_RENDER_ENGINE=motion ngunit walang image backend (i-enable ang ComfyUI o Pollinations)'
      : `PREFERRED_RENDER_ENGINE=motion ngunit hindi makapag-render (image backend: ${backend})`;
  }
  return `${comfyVideoDetail()}; at walang FAL_KEY para sa Wan 2.2 fallback`;
}

/**
 * Render one clip using the engine chosen by PREFERRED_RENDER_ENGINE. The raw
 * clip is optionally routed through OpenCut, then returned as a Buffer.
 */
export async function renderVideo(input: VideoRenderInput): Promise<VideoRenderResult> {
  const { data, engine } = await generateRaw(input);
  const edited = await maybeEdit(data, input.editInstructions);
  return { data: edited.data, engine, editor: edited.editor, editNote: edited.note };
}

async function generateRaw(input: VideoRenderInput): Promise<{ data: Buffer; engine: 'comfyui' | 'wan' | 'motion' }> {
  const preferred = preferredRenderEngine();

  // No cost: a free image, animated with ffmpeg. No cloud spend, no account.
  if (preferred === 'motion') {
    console.log('[RENDER] Using the free motion engine (image + ffmpeg).');
    return await generateMotionClip(input);
  }

  // Cloud-first: go straight to Wan 2.2 and never ping the local ComfyUI.
  if (preferred === 'fal') {
    console.log('[RENDER] Using fal.ai (Wan 2.2) as Primary Engine.');
    if (!wanConfigured()) {
      throw new VideoBackendUnavailable(
        `PREFERRED_RENDER_ENGINE=fal ngunit walang FAL_KEY para sa Wan 2.2 (${wanEndpoint()})`,
      );
    }
    try {
      const { data } = await generateVideoWithWan({
        prompt: input.prompt,
        negative: input.negative,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
      });
      return { data, engine: 'wan' };
    } catch (error: any) {
      throw new VideoBackendUnavailable(
        `Wan 2.2 (${wanEndpoint()}) nabigo: ${error?.message || error}`,
      );
    }
  }

  // Local-first: try ComfyUI, then fall back to Wan 2.2 on fal.ai.
  const comfyFailure = await comfyAttempt(input);
  if (comfyFailure.data) return { data: comfyFailure.data, engine: 'comfyui' };

  if (wanConfigured()) {
    try {
      const { data } = await generateVideoWithWan({
        prompt: input.prompt,
        negative: input.negative,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
      });
      return { data, engine: 'wan' };
    } catch (error: any) {
      throw new VideoBackendUnavailable(
        `ComfyUI (${comfyFailure.reason}) at Wan 2.2 (${wanEndpoint()}) nabigo: ${error?.message || error}`,
      );
    }
  }

  if (!falKeyConfigured()) {
    throw new VideoBackendUnavailable(
      `${comfyFailure.reason}; at walang FAL_KEY (Wan 2.2 fallback)`,
    );
  }
  throw new VideoBackendUnavailable(`ComfyUI (${comfyFailure.reason}); Wan 2.2 fallback walang FAL_KEY`);
}

/** One ComfyUI attempt. Returns the clip, or the reason it could not render. */
async function comfyAttempt(input: VideoRenderInput): Promise<{ data?: Buffer; reason: string }> {
  if (!(await comfyVideoReady())) return { reason: comfyVideoDetail() };
  try {
    const { data } = await generateVideoWithComfy(input.prompt, { negative: input.negative });
    return { data, reason: '' };
  } catch (error: any) {
    return { reason: `ComfyUI render failed: ${error?.message || error}` };
  }
}

/**
 * The no-cost engine: generate one free still (ComfyUI when it is up, else
 * Pollinations, which needs no key and no GPU), then turn it into a real clip
 * with ffmpeg's ken-burns pan/zoom. The result is a genuine MP4 at the film's
 * frame rate — not a stub. `seconds` is honoured (default 5, clamped to 30).
 */
async function generateMotionClip(input: VideoRenderInput): Promise<{ data: Buffer; engine: 'motion' }> {
  if (process.env.MOTION_DISABLE === '1') {
    throw new VideoBackendUnavailable('MOTION_DISABLE=1: ang libreng motion engine ay naka-off');
  }
  const seconds = Math.min(Math.max(input.seconds ?? 5, 1), 30);
  const [width, height] = motionDimensions(input.aspectRatio);

  let still;
  try {
    still = await imagine(input.prompt);
  } catch (error: any) {
    throw new VideoBackendUnavailable(
      `libreng motion engine: nabigo ang image generation (${error?.message || error})`,
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
  try {
    const imagePath = path.join(dir, `scene.${still.ext}`);
    fs.writeFileSync(imagePath, still.data);
    const out = await imageToVideo([imagePath], { secondsPerImage: seconds, width, height });
    if (!out.data.length) throw new Error('walang na-produce na clip');
    console.log(`[RENDER] motion clip: ${still.backend} image -> ${out.data.length} bytes, ${seconds}s ${width}x${height}`);
    return { data: out.data, engine: 'motion' };
  } catch (error: any) {
    throw new VideoBackendUnavailable(`libreng motion engine nabigo: ${error?.message || error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Frame size for the free engine, so 9:16 requests stay vertical for phones. */
function motionDimensions(aspect?: string): [number, number] {
  if (aspect === '9:16') return [720, 1280];
  if (aspect === '1:1') return [1024, 1024];
  return [1280, 720];
}

/** Run the OpenCut editing pass when it is configured and asked for. */
async function maybeEdit(
  data: Buffer,
  instructions?: string,
): Promise<{ data: Buffer; editor?: 'opencut'; note?: string }> {
  if (!instructions?.trim()) return { data };
  if (!openCutConfigured()) {
    return { data, note: 'OpenCut editing skipped: OPENCUT_ENDPOINT is not set' };
  }
  try {
    const url = await uploadToFal(data);
    const edited = await editWithOpenCut(url, instructions.trim());
    return { data: edited.data, editor: 'opencut', note: 'OpenCut editing applied' };
  } catch (error: any) {
    // A failed edit must not throw away a good render: keep the raw clip.
    return { data, note: `OpenCut editing failed: ${error?.message || error}` };
  }
}
