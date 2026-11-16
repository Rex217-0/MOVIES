/**
 * The video render pipeline: a raw clip is generated, then optionally edited
 * before it is saved to the Render Vault.
 *
 * Generation order is set by the PREFERRED_RENDER_ENGINE switch:
 *   PREFERRED_RENDER_ENGINE=comfyui  Local-first (the default): try the local
 *                                    ComfyUI (Server-2 GPU) first, then the free
 *                                    motion engine, then Wan 2.2 on fal.ai when
 *                                    paid cloud is allowed.
 *   PREFERRED_RENDER_ENGINE=fal      Cloud-first: route straight to Wan 2.2 on
 *                                    fal.ai and do NOT ping ComfyUI.
 *   PREFERRED_RENDER_ENGINE=motion   No cost: a real clip from a free image
 *                                    backend (ComfyUI, else Pollinations, which
 *                                    needs no key and no GPU) animated with
 *                                    ffmpeg. No cloud spend, no account.
 * Unset defaults to `comfyui`, the free local-first chain. The project rule is
 * free-first: a fresh install must never reach a paid call by accident.
 *
 * ComfyUI has a master on/off switch (`comfyui_enabled` in the UI, which sets
 * `COMFYUI_DISABLE`). Turning it off never blocks a render: the free motion
 * engine catches the job, so a film still gets made.
 *
 * No-cost policy: Wan 2.2 (fal.ai) is paid, so it runs only when both FAL_KEY is
 * set and ALLOW_PAID_CLOUD=1. Without that opt-in the free engines are the only
 * ones, and the call fails honestly when none of them can render.
 *
 * Editing is an optional post-process on a finished clip:
 *   OpenCut on fal.ai — cuts, transitions and colour grading (also paid).
 *
 * When nothing can render, this throws `VideoBackendUnavailable`. The API turns
 * that into a 503 `AI_UNAVAILABLE`. A placeholder clip is never returned.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { comfyAvailable, comfyVideoConfigured, diagnoseComfyVideo, generateVideoWithComfy } from './comfyui.ts';
import { imagine } from './imagine.ts';
import { imageToVideo } from './render.ts';
import {
  falKeyConfigured, openCutConfigured, wanConfigured, wanEndpoint,
  generateVideoWithWan, editWithOpenCut, uploadToFal,
} from './fal.ts';
import { paidCloudAllowed, paidReady, PAID_BLOCKED_DETAIL } from './costPolicy.ts';

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
 * The PREFERRED_RENDER_ENGINE master switch. Free-first by default: an unset or
 * unrecognised value means `comfyui`, whose chain ends in the free motion
 * engine. Only an explicit `fal` routes to paid cloud (and still needs
 * ALLOW_PAID_CLOUD=1 to actually run).
 */
export function preferredRenderEngine(): PreferredRenderEngine {
  const raw = (process.env.PREFERRED_RENDER_ENGINE || 'comfyui').trim().toLowerCase();
  if (raw === 'fal' || raw === 'cloud') return 'fal';
  if (raw === 'motion' || raw === 'free' || raw === 'nocost') return 'motion';
  return 'comfyui';
}

/** True when the paid Wan 2.2 path on fal.ai may run: configured and opted in. */
export function wanAllowed(): boolean {
  return paidReady(wanConfigured());
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
  return (await diagnoseComfyVideo()).ready;
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

/**
 * Why the local ComfyUI video backend is not ready, for an honest message. The
 * exact cause comes from `diagnoseComfyVideo`: the server disabled ComfyUI, no
 * workflow is configured, the workflow file is missing, the workflow has an
 * unfilled placeholder, or the URL is unreachable.
 */
export async function comfyVideoDetail(): Promise<string> {
  return (await diagnoseComfyVideo()).detail;
}

/**
 * True when the preferred engine can render right now. Local-first (comfyui,
 * the free default) is ready when any engine in its failover chain can run:
 * ComfyUI, the free motion engine, or Wan 2.2 when paid cloud is allowed. The
 * no-cost motion engine needs only a free image backend.
 */
export async function videoRenderReady(): Promise<boolean> {
  const preferred = preferredRenderEngine();
  if (preferred === 'fal') return wanAllowed();
  if (preferred === 'motion') return motionReady();
  return (await comfyVideoReady()) || (await motionReady()) || wanAllowed();
}

/** Why no video engine can render, for an honest error message. */
export async function videoRenderDetail(): Promise<string> {
  const preferred = preferredRenderEngine();
  if (preferred === 'fal') {
    if (wanConfigured() && !paidCloudAllowed()) return PAID_BLOCKED_DETAIL;
    return `PREFERRED_RENDER_ENGINE=fal: kailangan ng FAL_KEY para sa Wan 2.2 (${wanEndpoint()})`;
  }
  if (preferred === 'motion') {
    const { imageBackend } = await import('./imagine.ts');
    const backend = await imageBackend();
    return backend === 'none'
      ? 'PREFERRED_RENDER_ENGINE=motion ngunit walang image backend (i-enable ang ComfyUI o Pollinations)'
      : `PREFERRED_RENDER_ENGINE=motion ngunit hindi makapag-render (image backend: ${backend})`;
  }
  const fallback = wanConfigured() && !paidCloudAllowed()
    ? PAID_BLOCKED_DETAIL
    : `walang FAL_KEY para sa Wan 2.2 fallback`;
  return `${await comfyVideoDetail()}, libreng motion engine, at ${fallback}`;
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

  // Cloud-first: go straight to Wan 2.2 and never ping the local ComfyUI. Still
  // blocked by the no-cost policy unless the deployment opted in.
  if (preferred === 'fal') {
    console.log('[RENDER] Using fal.ai (Wan 2.2) as Primary Engine.');
    if (!wanAllowed()) {
      throw new VideoBackendUnavailable(
        wanConfigured() ? PAID_BLOCKED_DETAIL
          : `PREFERRED_RENDER_ENGINE=fal ngunit walang FAL_KEY para sa Wan 2.2 (${wanEndpoint()})`,
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

  // Local-first: try ComfyUI, then the free motion engine, then Wan 2.2. Each
  // step only runs when the one before it could not, so a ComfyUI that is off,
  // unreachable or has no video workflow still ends in a real clip.
  const comfyFailure = await comfyAttempt(input);
  if (comfyFailure.data) return { data: comfyFailure.data, engine: 'comfyui' };

  // The free engine is the first thing that catches a missing ComfyUI: it needs
  // no key, no GPU and no account.
  if (await motionReady()) {
    try {
      const { data } = await generateMotionClip(input);
      console.log(`[RENDER] ComfyUI hindi available (${comfyFailure.reason}); libreng motion engine ang sumalo.`);
      return { data, engine: 'motion' };
    } catch (error: any) {
      console.log(`[RENDER] motion engine nabigo: ${error?.message || error}`);
    }
  }

  if (wanAllowed()) {
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
        `ComfyUI (${comfyFailure.reason}), libreng motion engine, at Wan 2.2 (${wanEndpoint()}) nabigo: ${error?.message || error}`,
      );
    }
  }

  if (wanConfigured() && !paidCloudAllowed()) {
    throw new VideoBackendUnavailable(`${comfyFailure.reason}; at ${PAID_BLOCKED_DETAIL}`);
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
  const diagnosis = await diagnoseComfyVideo();
  if (!diagnosis.ready) {
    console.warn(`[RENDER] ComfyUI video backend hindi handa (${diagnosis.problem}): ${diagnosis.detail}`);
    return { reason: diagnosis.detail };
  }
  try {
    const { data } = await generateVideoWithComfy(input.prompt, { negative: input.negative });
    return { data, reason: '' };
  } catch (error: any) {
    const reason = `ComfyUI render failed: ${error?.message || error}`;
    console.error(`[RENDER] ${reason}`);
    return { reason };
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
  if (!paidCloudAllowed()) return { data, note: `OpenCut editing skipped: ${PAID_BLOCKED_DETAIL}` };
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
