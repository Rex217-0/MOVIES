/**
 * Image generation, with the same free-first order as the rest of the app:
 * local ComfyUI when it is running, otherwise the Gemini image model.
 *
 * The connectors use this so a poster request that only has a *prompt* (not a
 * file) still produces a real image, instead of failing with "source not found".
 */

import { GoogleGenAI } from '@google/genai';
import { IMAGE_MODEL, IMAGE_MODEL_FREE } from '../config.ts';
import { buildVeoStylePrompt, buildVeoStyleNegative } from '../tactical/rules.ts';
import { generateWithComfy, comfyAvailable } from './comfyui.ts';

export type ImageBackend = 'comfyui' | 'gemini' | 'none';

let client: GoogleGenAI | null = null;

function gemini(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: 'v1beta' });
  return client;
}

let comfyCache: { ok: boolean; at: number } | null = null;

/** Which backend would generate an image right now. */
export async function imageBackend(): Promise<ImageBackend> {
  if (process.env.COMFYUI_DISABLE !== '1') {
    if (!comfyCache || Date.now() - comfyCache.at > 15000) {
      comfyCache = { ok: await comfyAvailable(), at: Date.now() };
    }
    if (comfyCache.ok) return 'comfyui';
  }
  if (process.env.GEMINI_API_KEY && IMAGE_MODEL_FREE) return 'gemini';
  return 'none';
}

export interface GeneratedImage {
  data: Buffer;
  ext: 'png';
  mime: 'image/png';
  backend: ImageBackend;
}

function extractImage(interaction: any): Buffer | null {
  const direct = interaction?.output_image?.data;
  if (direct) return Buffer.from(direct, 'base64');
  for (const step of interaction?.steps || []) {
    if (step?.type === 'model_output') {
      const found = step.content?.find((c: any) => c.type === 'image');
      if (found?.data) return Buffer.from(found.data, 'base64');
    }
  }
  return null;
}

/**
 * Generate one image from a prompt. Throws a clear error when no backend is
 * available, so the caller can fall back to a text-only poster.
 */
export async function imagine(prompt: string): Promise<GeneratedImage> {
  const enhanced = buildVeoStylePrompt(prompt);
  const backend = await imageBackend();

  if (backend === 'comfyui') {
    const png = await generateWithComfy(enhanced, { negative: buildVeoStyleNegative(), width: 1024, height: 1024 });
    return { data: png, ext: 'png', mime: 'image/png', backend };
  }

  if (backend === 'gemini') {
    const ai = gemini()!;
    const interaction = await ai.interactions.create({
      model: IMAGE_MODEL,
      input: enhanced,
      response_modalities: ['image', 'text'],
      generation_config: { image_config: { aspect_ratio: '1:1', image_size: '1K' } },
    });
    const data = extractImage(interaction);
    if (!data) throw new Error('Walang image na ibinalik ang model.');
    return { data, ext: 'png', mime: 'image/png', backend };
  }

  throw new Error('Walang available na image backend. Patakbuhin ang ComfyUI o mag-set ng GEMINI_API_KEY.');
}
