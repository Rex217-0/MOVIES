/**
 * Image generation, with the same free-first order as the rest of the app:
 * local ComfyUI when it is running, otherwise the Gemini image model.
 *
 * The connectors use this so a poster request that only has a *prompt* (not a
 * file) still produces a real image, instead of failing with "source not found".
 */

import { GoogleGenAI } from '@google/genai';
import { countExternalCall } from './externalCalls.ts';
import { IMAGE_MODEL, IMAGE_MODEL_FREE } from '../config.ts';
import { buildVeoStylePrompt, buildVeoStyleNegative } from '../tactical/rules.ts';
import { generateWithComfy, comfyAvailable, type ComfyRenderFacts } from './comfyui.ts';
import { toPng } from './render.ts';

export type ImageBackend = 'comfyui' | 'gemini' | 'pollinations' | 'none';

/**
 * The Pollinations base URL. Overridable so a deployment can point at a proxy,
 * and so the tests can serve a local stand-in instead of the real service.
 */
export function pollinationsUrl(): string {
  return (process.env.POLLINATIONS_URL || 'https://image.pollinations.ai').replace(/\/+$/, '');
}

let client: GoogleGenAI | null = null;

function gemini(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: 'v1beta' });
  return client;
}

let comfyCache: { ok: boolean; at: number } | null = null;

/**
 * Drop the cached ComfyUI reachability. The settings UI calls this after a
 * toggle so the very next request sees the new switch, not a stale probe.
 */
export function resetComfyCache(): void {
  comfyCache = null;
}

/** Which backend would generate an image right now. */
export async function imageBackend(): Promise<ImageBackend> {
  if (process.env.COMFYUI_DISABLE !== '1') {
    if (!comfyCache || Date.now() - comfyCache.at > 15000) {
      comfyCache = { ok: await comfyAvailable(), at: Date.now() };
    }
    if (comfyCache.ok) return 'comfyui';
  }
  if (process.env.GEMINI_API_KEY && IMAGE_MODEL_FREE) return 'gemini';
  // Pollinations needs no key and no GPU, so it is the free default.
  if (process.env.POLLINATIONS_DISABLE !== '1') return 'pollinations';
  return 'none';
}

export interface GeneratedImage {
  data: Buffer;
  ext: 'png';
  mime: 'image/png';
  backend: ImageBackend;
  /** Present only for ComfyUI: the seed and graph the still was made with. */
  render?: ComfyRenderFacts;
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
/**
 * How long a throttled Pollinations image call asks us to wait, or null when the
 * answer is not a rate limit. The free tier allows roughly one picture every
 * 15-45 seconds per IP, so the hint matters more than a fixed backoff.
 */
function pollinationsRetryMs(status: number, body: string): number | null {
  if (status !== 402 && status !== 429 && status !== 503) return null;
  const match = /retry after (\d+)/i.exec(body) || /"retry_after"\s*:\s*(\d+)/i.exec(body);
  const seconds = match ? Number(match[1]) : 20;
  if (!Number.isFinite(seconds) || seconds > 90) return null;
  return Math.max(1000, seconds * 1000 + 500);
}

export async function imagine(prompt: string): Promise<GeneratedImage> {
  const enhanced = buildVeoStylePrompt(prompt);
  const backend = await imageBackend();

  if (backend === 'comfyui') {
    const { data: png, render } = await generateWithComfy(enhanced, {
      negative: buildVeoStyleNegative(), width: 1024, height: 1024,
    });
    return { data: png, ext: 'png', mime: 'image/png', backend, render };
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

  if (backend === 'pollinations') {
    // Pollinations sheds load with a 503 under a burst, and one shed request
    // must not cost the film its picture. Retry with a short backoff and fall
    // through the free models before giving up.
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      // Only width/height/nologo are on the keyless tier. Naming a `model` or a
      // `seed` silently moves the request to the paid queue and answers 402, and
      // 512x512 is the largest free size. The shot is upscaled with lanczos and
      // carries grain, so the small source reads as a film still, not a blob.
      const url = `${pollinationsUrl()}/prompt/${encodeURIComponent(enhanced)}` +
        `?width=512&height=512&nologo=true`;
      try {
        countExternalCall();
        const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!res.ok) {
          // The keyless image tier throttles per IP and answers 402/429 with a
          // "retry after Ns" hint. A film needs one picture per scene, so a
          // 1.5s backoff cannot clear it — scene 1 died on exactly this while
          // scene 2 rendered fine. Honour the hint when it is short enough to
          // be worth waiting for.
          last = `Pollinations returned ${res.status}`;
          const hint = await res.text().catch(() => '');
          const wait = pollinationsRetryMs(res.status, hint);
          if (wait !== null) {
            if (attempt < 3) await new Promise(r => setTimeout(r, wait));
            continue;
          }
        } else {
          const raw = Buffer.from(await res.arrayBuffer());
          if (raw.length >= 1024) {
            // Pollinations answers with a JPEG whatever the URL asks for; store a PNG.
            return { data: await toPng(raw), ext: 'png', mime: 'image/png', backend };
          }
          last = 'Pollinations returned an empty image.';
        }
      } catch (error: any) {
        last = error?.message || String(error);
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw new Error(last || 'Pollinations failed.');
  }

  throw new Error('Walang available na image backend. Patakbuhin ang ComfyUI o mag-set ng GEMINI_API_KEY.');
}
