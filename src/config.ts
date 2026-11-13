/**
 * Shared model configuration and honest-availability helpers.
 *
 * Only models that are actually available on the Gemini API free tier are used
 * for real generation. Image and video generation have no free-tier model, so
 * those endpoints report the service as unavailable instead of fabricating
 * output. See https://ai.google.dev/gemini-api/docs/pricing
 */

export const TEXT_MODEL = 'gemini-2.5-flash';
export const IMAGE_MODEL = 'gemini-2.5-flash-image';
export const VIDEO_MODEL = 'gemini-omni-1.2-flash';

/** Machines that produce generated media on the free tier. */
export const IMAGE_MODEL_FREE: boolean = false;
export const VIDEO_MODEL_FREE: boolean = false;

export interface ServiceError {
  error: string;
  code: 'AI_UNAVAILABLE';
  model: string;
  detail: string;
}

export function aiUnavailable(model: string, detail: string, reason?: string): ServiceError {
  const base = reason || `Model "${model}" did not return a usable result`;
  return {
    error: `${base}. ${detail}`,
    code: 'AI_UNAVAILABLE',
    model,
    detail,
  };
}

export const NO_FREE_IMAGE_MODEL =
  'No image model is available on the Gemini free tier (nano-banana models are paid only). ' +
  'Enable billing and set GEMINI_API_KEY, or remove the image features.';

export const NO_FREE_VIDEO_MODEL =
  'No video model is available on the Gemini free tier (Omni Flash is paid only). ' +
  'Enable billing and set GEMINI_API_KEY, or remove the video features.';
