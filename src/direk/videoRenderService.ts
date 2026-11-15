/**
 * The video render pipeline: a raw clip is generated, then optionally edited
 * before it is saved to the Render Vault.
 *
 * Generation order is set by the PREFERRED_RENDER_ENGINE switch:
 *   PREFERRED_RENDER_ENGINE=comfyui  Local-first (the default): try the local
 *                                    ComfyUI (Server-2 GPU) first, then Wan 2.2
 *                                    on fal.ai when paid cloud is allowed.
 *   PREFERRED_RENDER_ENGINE=fal      Cloud-first: route straight to Wan 2.2 on
 *                                    fal.ai and do NOT ping ComfyUI.
 * Unset defaults to `comfyui`, so the factory is free-first until a deployment
 * opts in.
 *
 * No-cost policy: Wan 2.2 (fal.ai) is paid, so it runs only when both FAL_KEY is
 * set and ALLOW_PAID_CLOUD=1. Without that opt-in the local ComfyUI is the only
 * engine, and the call fails honestly when it cannot render.
 *
 * Editing is an optional post-process on a finished clip:
 *   OpenCut on fal.ai — cuts, transitions and colour grading (also paid).
 *
 * When nothing can render, this throws `VideoBackendUnavailable`. The API turns
 * that into a 503 `AI_UNAVAILABLE`. A placeholder clip is never returned.
 */
import { generateVideoWithComfy, diagnoseComfyVideo } from './comfyui.ts';
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
export type PreferredRenderEngine = 'fal' | 'comfyui';

/**
 * The PREFERRED_RENDER_ENGINE master switch. Free-first by default: an unset or
 * unrecognised value means `comfyui` (the local GPU). `fal` is the paid cloud
 * path and still needs ALLOW_PAID_CLOUD=1 to actually run.
 */
export function preferredRenderEngine(): PreferredRenderEngine {
  const raw = (process.env.PREFERRED_RENDER_ENGINE || 'comfyui').trim().toLowerCase();
  return raw === 'fal' || raw === 'cloud' ? 'fal' : 'comfyui';
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
  /** Optional editing instructions; when set, OpenCut runs on the raw clip. */
  editInstructions?: string;
}

export interface VideoRenderResult {
  data: Buffer;
  /** Which engine produced the clip: `comfyui` or `wan`. */
  engine: 'comfyui' | 'wan';
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
 * the default) needs the ComfyUI workflow; the paid Wan 2.2 fallback counts
 * only when ALLOW_PAID_CLOUD=1.
 */
export async function videoRenderReady(): Promise<boolean> {
  if (preferredRenderEngine() === 'fal') return wanAllowed();
  return (await comfyVideoReady()) || wanAllowed();
}

/** Why no video engine can render, for an honest error message. */
export async function videoRenderDetail(): Promise<string> {
  if (preferredRenderEngine() === 'fal') {
    if (wanConfigured() && !paidCloudAllowed()) return PAID_BLOCKED_DETAIL;
    return `PREFERRED_RENDER_ENGINE=fal: kailangan ng FAL_KEY para sa Wan 2.2 (${wanEndpoint()})`;
  }
  const fallback = wanConfigured() && !paidCloudAllowed()
    ? PAID_BLOCKED_DETAIL
    : `walang FAL_KEY para sa Wan 2.2 fallback`;
  return `${await comfyVideoDetail()}; at ${fallback}`;
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

async function generateRaw(input: VideoRenderInput): Promise<{ data: Buffer; engine: 'comfyui' | 'wan' }> {
  const preferred = preferredRenderEngine();

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

  // Local-first: try ComfyUI, then fall back to Wan 2.2 on fal.ai when allowed.
  const comfyFailure = await comfyAttempt(input);
  if (comfyFailure.data) return { data: comfyFailure.data, engine: 'comfyui' };

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
        `ComfyUI (${comfyFailure.reason}) at Wan 2.2 (${wanEndpoint()}) nabigo: ${error?.message || error}`,
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
