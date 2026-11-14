/**
 * The video render pipeline: a raw clip is generated, then optionally edited
 * before it is saved to the Render Vault.
 *
 * Generation order (first that can really render wins):
 *   1. Local ComfyUI (Server-2 GPU) — free, the primary path.
 *   2. Wan 2.2 on fal.ai — the T3 fallback, used only when ComfyUI cannot.
 *
 * Editing is an optional post-process on a finished clip:
 *   3. OpenCut on fal.ai — cuts, transitions and colour grading.
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

/** True when any real video engine can render: ComfyUI first, Wan 2.2 next. */
export async function videoRenderReady(): Promise<boolean> {
  return (await comfyVideoReady()) || wanConfigured();
}

/** Why no video engine can render, for an honest error message. */
export function videoRenderDetail(): string {
  return `${comfyVideoDetail()}; at walang FAL_KEY para sa Wan 2.2 fallback`;
}

/**
 * Render one clip. Tries the local ComfyUI first, then Wan 2.2 on fal.ai. The
 * raw clip is optionally routed through OpenCut, then returned as a Buffer.
 */
export async function renderVideo(input: VideoRenderInput): Promise<VideoRenderResult> {
  const { data, engine } = await generateRaw(input);
  const edited = await maybeEdit(data, input.editInstructions);
  return { data: edited.data, engine, editor: edited.editor, editNote: edited.note };
}

async function generateRaw(input: VideoRenderInput): Promise<{ data: Buffer; engine: 'comfyui' | 'wan' }> {
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
