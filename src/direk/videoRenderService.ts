/**
 * The video render pipeline: a raw clip is generated on the local ComfyUI
 * (Server-2 GPU), then optionally edited before it is saved to the Render Vault.
 *
 * Video comes from ComfyUI only. There is no slideshow, zoom or gradient
 * fallback: a picture that a video model did not generate is not a video, so
 * when ComfyUI cannot render this throws `VideoBackendUnavailable` and the API
 * answers 503 `AI_UNAVAILABLE` with the exact cause. Nothing is ever faked.
 *
 * Configuration (environment variables):
 *   COMFYUI_URL             Base URL of the ComfyUI server (Server-2 GPU).
 *   COMFYUI_VIDEO_WORKFLOW  Path to the video workflow (API format) whose
 *                           placeholders the builder fills.
 *   COMFYUI_DISABLE=1       Turn the backend off entirely.
 *   ALLOW_PAID_CLOUD=1      Allow the optional OpenCut editing pass (paid).
 *
 * Editing is an optional post-process on a finished clip:
 *   OpenCut on fal.ai — cuts, transitions and colour grading (also paid).
 *
 * When nothing can render, this throws `VideoBackendUnavailable`. The API turns
 * that into a 503 `AI_UNAVAILABLE`. A placeholder clip is never returned.
 */
import { diagnoseComfyVideo, generateVideoWithComfy } from './comfyui.ts';
import { openCutConfigured, editWithOpenCut, uploadToFal } from './fal.ts';
import { paidCloudAllowed, PAID_BLOCKED_DETAIL } from './costPolicy.ts';

export class VideoBackendUnavailable extends Error {
  readonly code = 'AI_UNAVAILABLE';
  constructor(detail: string) {
    super(`Walang video backend: ${detail}`);
    this.name = 'VideoBackendUnavailable';
  }
}

/** The only video generation engine. Written to every job record. */
export const VIDEO_ENGINE = 'comfyui' as const;

export interface VideoRenderInput {
  prompt: string;
  negative?: string;
  aspectRatio?: string;
  resolution?: string;
  /** Target clip length in seconds. */
  seconds?: number;
  /** Optional editing instructions; when set, OpenCut runs on the raw clip. */
  editInstructions?: string;
}

export interface VideoRenderResult {
  data: Buffer;
  /** Which engine produced the clip. Always `comfyui`. */
  engine: typeof VIDEO_ENGINE;
  /** Which engine edited it, when the editing pass ran. */
  editor?: 'opencut';
  /** A short human-readable note about the editing pass, for the logs. */
  editNote?: string;
}

/** True when the local ComfyUI video backend can render right now. */
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

/** True when the ComfyUI video backend can render right now. */
export async function videoRenderReady(): Promise<boolean> {
  return comfyVideoReady();
}

/** Why no video engine can render, for an honest error message. */
export async function videoRenderDetail(): Promise<string> {
  return comfyVideoDetail();
}

/**
 * Render one clip on the local ComfyUI. The raw clip is optionally routed
 * through OpenCut, then returned as a Buffer.
 */
export async function renderVideo(input: VideoRenderInput): Promise<VideoRenderResult> {
  const data = await generateRaw(input);
  const edited = await maybeEdit(data, input.editInstructions);
  return { data: edited.data, engine: VIDEO_ENGINE, editor: edited.editor, editNote: edited.note };
}

/**
 * Generate one clip on the local ComfyUI. Fails with the exact reason (the
 * server is off, no workflow is set, the workflow file is missing, it has an
 * unfilled placeholder, or the URL is unreachable) instead of falling back to a
 * slideshow.
 */
async function generateRaw(input: VideoRenderInput): Promise<Buffer> {
  const diagnosis = await diagnoseComfyVideo();
  if (!diagnosis.ready) {
    throw new VideoBackendUnavailable(diagnosis.detail);
  }
  try {
    const { data } = await generateVideoWithComfy(input.prompt, { negative: input.negative });
    if (!data.length) throw new Error('walang na-produce na clip');
    return data;
  } catch (error: any) {
    throw new VideoBackendUnavailable(`ComfyUI render failed: ${error?.message || error}`);
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
