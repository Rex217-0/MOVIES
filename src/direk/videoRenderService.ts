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
 * Unset defaults to `fal`, so the factory is cloud-first until ComfyUI is live
 * on Server-2.
 *
 * Editing is an optional post-process on a finished clip:
 *   OpenCut on fal.ai — cuts, transitions and colour grading.
 *
 * When nothing can render, this throws `VideoBackendUnavailable`. The API turns
 * that into a 503 `AI_UNAVAILABLE`. A placeholder clip is never returned.
 */
import { comfyAvailable, comfyVideoConfigured, generateVideoWithComfy } from './comfyui.ts';
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
export type PreferredRenderEngine = 'fal' | 'comfyui';

/**
 * The PREFERRED_RENDER_ENGINE master switch. Cloud-first by default: an unset
 * or unrecognised value means `fal`.
 */
export function preferredRenderEngine(): PreferredRenderEngine {
  const raw = (process.env.PREFERRED_RENDER_ENGINE || 'fal').trim().toLowerCase();
  return raw === 'comfyui' || raw === 'comfy' || raw === 'local' ? 'comfyui' : 'fal';
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
  if (process.env.COMFYUI_DISABLE === '1') return false;
  if (!comfyVideoConfigured()) return false;
  return comfyAvailable();
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
 * only FAL_KEY; local-first (comfyui) also accepts Wan 2.2 as a fallback.
 */
export async function videoRenderReady(): Promise<boolean> {
  if (preferredRenderEngine() === 'fal') return wanConfigured();
  return (await comfyVideoReady()) || wanConfigured();
}

/** Why no video engine can render, for an honest error message. */
export function videoRenderDetail(): string {
  if (preferredRenderEngine() === 'fal') {
    return `PREFERRED_RENDER_ENGINE=fal: kailangan ng FAL_KEY para sa Wan 2.2 (${wanEndpoint()})`;
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

async function generateRaw(input: VideoRenderInput): Promise<{ data: Buffer; engine: 'comfyui' | 'wan' }> {
  const preferred = preferredRenderEngine();

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
