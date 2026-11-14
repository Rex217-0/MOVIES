/**
 * fal.ai integration: Wan 2.2 (video generation) and OpenCut (video editing).
 *
 * Both run on fal.ai behind one `FAL_KEY`. Wan 2.2 is the T3 fallback used when
 * the local ComfyUI cannot render a shot; OpenCut is the optional editor applied
 * to a finished clip before it is saved to the Render Vault.
 *
 * Endpoints are configurable because fal.ai versions and renames models.
 * `WAN_VIDEO_ENDPOINT` defaults to the verified text-to-video endpoint
 * (`fal-ai/wan/v2.2-a14b/text-to-video`). `OPENCUT_ENDPOINT` has no default:
 * OpenCut (https://opencut.app) is a self-hosted editor, not a fal.ai hosted
 * model, so set this to the editing endpoint your fal.ai account exposes. With
 * it unset, the editing pass is skipped and the raw clip is kept.
 */
import { fal } from '@fal-ai/client';

/** The verified fal.ai text-to-video endpoint for Wan 2.2. */
export const DEFAULT_WAN_ENDPOINT = 'fal-ai/wan/v2.2-a14b/text-to-video';

/** The slice of the fal client this module uses, so tests can supply a fake. */
export interface FalLike {
  config(config: { credentials?: string }): void;
  subscribe(endpointId: string, options: { input: Record<string, unknown>; logs?: boolean }): Promise<{ data: any }>;
  storage: { upload(file: Blob): Promise<string> };
}

let client: FalLike = fal as unknown as FalLike;
let configuredKey: string | undefined;

/** Test seam: swap the fal client for a fake. Not for production use. */
export function setFalClientForTests(fake: FalLike | null): void {
  client = fake ?? (fal as unknown as FalLike);
  configuredKey = undefined;
}

export type WanAspect = '16:9' | '9:16' | '1:1';
export type WanResolution = '480p' | '580p' | '720p';

/** Point the fal client at FAL_KEY. Cheap and safe to call on every request. */
export function configureFal(): void {
  const key = process.env.FAL_KEY?.trim();
  if (!key || key === configuredKey) return;
  client.config({ credentials: key });
  configuredKey = key;
}

export function falKeyConfigured(): boolean {
  return Boolean(process.env.FAL_KEY?.trim());
}

export function wanEndpoint(): string {
  return process.env.WAN_VIDEO_ENDPOINT?.trim() || DEFAULT_WAN_ENDPOINT;
}

export function openCutEndpoint(): string {
  return process.env.OPENCUT_ENDPOINT?.trim() || '';
}

/** Wan 2.2 needs only FAL_KEY; the endpoint has a verified default. */
export function wanConfigured(): boolean {
  return falKeyConfigured();
}

/** OpenCut also needs an explicit endpoint; there is no hosted default. */
export function openCutConfigured(): boolean {
  return falKeyConfigured() && Boolean(openCutEndpoint());
}

export interface WanVideoInput {
  prompt: string;
  negative?: string;
  aspectRatio?: string;
  resolution?: string;
}

/** Generate one clip with Wan 2.2 on fal.ai and download it as a Buffer. */
export async function generateVideoWithWan(input: WanVideoInput): Promise<{ data: Buffer; url: string }> {
  configureFal();
  if (!wanConfigured()) throw new Error('FAL_KEY is not set');
  const endpoint = wanEndpoint();
  const { data } = await client.subscribe(endpoint, {
    input: {
      prompt: input.prompt,
      negative_prompt: input.negative ?? '',
      aspect_ratio: normaliseAspect(input.aspectRatio),
      resolution: normaliseResolution(input.resolution),
    },
    logs: false,
  });
  const url = (data as any)?.video?.url;
  if (!url) throw new Error(`Wan (${endpoint}) did not return a video`);
  return { data: await download(url), url };
}

/**
 * Edit a clip with OpenCut on fal.ai. The clip is uploaded first so the
 * endpoint can read it by URL, then the edited result is downloaded.
 */
export async function editWithOpenCut(videoUrl: string, instructions: string): Promise<{ data: Buffer; url: string }> {
  configureFal();
  if (!openCutConfigured()) throw new Error('OPENCUT_ENDPOINT is not set');
  const endpoint = openCutEndpoint();
  const { data } = await client.subscribe(endpoint, {
    input: { video_url: videoUrl, prompt: instructions },
    logs: false,
  });
  const url = (data as any)?.video?.url ?? (data as any)?.video_url;
  if (!url) throw new Error(`OpenCut (${endpoint}) did not return a video`);
  return { data: await download(url), url };
}

/** Upload a clip to fal storage so an endpoint can read it by URL. */
export async function uploadToFal(data: Buffer): Promise<string> {
  configureFal();
  if (!falKeyConfigured()) throw new Error('FAL_KEY is not set');
  const blob = new Blob([new Uint8Array(data)], { type: 'video/mp4' });
  return client.storage.upload(blob);
}

/** Wan 2.2 accepts 16:9, 9:16 and 1:1 only; anything else becomes 16:9. */
export function normaliseAspect(value?: string): WanAspect {
  return value === '9:16' || value === '1:1' ? value : '16:9';
}

/** Wan 2.2 accepts 480p, 580p and 720p only; anything else becomes 720p. */
export function normaliseResolution(value?: string): WanResolution {
  return value === '480p' || value === '580p' ? value : '720p';
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fal download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
