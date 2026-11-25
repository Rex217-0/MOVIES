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
import { comfyAvailable, comfyVideoConfigured, diagnoseComfyVideo, generateVideoWithComfy, type ComfyRenderFacts } from './comfyui.ts';
import { imagine } from './imagine.ts';
import { imageToVideo } from './render.ts';
import {
  falKeyConfigured, openCutConfigured, wanConfigured, wanEndpoint,
  generateVideoWithWan, editWithOpenCut, uploadToFal,
} from './fal.ts';
import { paidCloudAllowed, paidReady, PAID_BLOCKED_DETAIL } from './costPolicy.ts';
import { withExternalCallCounter } from './externalCalls.ts';
import { fetchStockClip, stockConfigured, toMp4 } from './stockVideo.ts';
import { strictRealVideoOnly, strictRefusalDetail } from './strictVideo.ts';
import {
  acceptsMediaClass, enginesForTier, masterBackendBlockedDetail,
  MASTER_BACKEND_UNAVAILABLE_CODE, mediaClassForEngine,
  type MediaClass, type QualityTier, type RenderEngine,
} from './mediaClass.ts';

export class VideoBackendUnavailable extends Error {
  readonly code: 'AI_UNAVAILABLE' | 'COMFYUI_WAN22_UNAVAILABLE' | 'REQUIRED_MASTER_BACKEND_UNAVAILABLE' = 'AI_UNAVAILABLE';
  constructor(detail: string) {
    super(`Walang video backend: ${detail}`);
    this.name = 'VideoBackendUnavailable';
  }
}

/**
 * A MASTER job refused a weaker engine. This is not a render failure: nothing
 * was attempted, because the policy forbids substituting still motion for a
 * promised synthetic render. Its own code lets the API answer with the block
 * state instead of a generic 503 outage.
 */
export class MasterBackendBlocked extends VideoBackendUnavailable {
  override readonly code = 'REQUIRED_MASTER_BACKEND_UNAVAILABLE';
  /** The tier that was refused, so the caller can echo it back. */
  readonly tier: QualityTier;
  constructor(detail: string, tier: QualityTier = 'MASTER') {
    super(masterBackendBlockedDetail(detail));
    this.name = 'MasterBackendBlocked';
    this.tier = tier;
  }
}

/**
 * The strict guard's refusal: ComfyUI cannot render with the Wan 2.2 weights and
 * `STRICT_REAL_VIDEO_ONLY` forbids a fallback clip. It carries its own code so
 * the API can answer 503 `COMFYUI_WAN22_UNAVAILABLE` and the caller can tell a
 * missing GPU dependency from a deployment with no backend at all.
 */
export class ComfyWan22Unavailable extends VideoBackendUnavailable {
  override readonly code = 'COMFYUI_WAN22_UNAVAILABLE';
  /** The exact files ComfyUI does not have, when the check could run. */
  readonly missing: string[];
  constructor(detail: string, missing: string[] = []) {
    super(detail);
    this.name = 'ComfyWan22Unavailable';
    this.missing = missing;
  }
}

/** Which engine the pipeline prefers as primary. */
export type PreferredRenderEngine = 'fal' | 'comfyui' | 'motion' | 'stock' | 'hybrid';

/**
 * The PREFERRED_RENDER_ENGINE master switch. Free-first by default: an unset or
 * unrecognised value means `comfyui`, whose chain ends in the free motion
 * engine. Only an explicit `fal` routes to paid cloud (and still needs
 * ALLOW_PAID_CLOUD=1 to actually run).
 *
 * `stock` and `hybrid` are the real-footage modes. Stock searches Pexels or
 * Pixabay for footage of real people, animals and places; it needs a free key
 * but no GPU. `hybrid` tries stock first and falls back to the local ComfyUI
 * chain, so a scene without a stock match is still generated rather than lost.
 */
export function preferredRenderEngine(): PreferredRenderEngine {
  const raw = (process.env.PREFERRED_RENDER_ENGINE || 'comfyui').trim().toLowerCase();
  if (raw === 'fal' || raw === 'cloud') return 'fal';
  if (raw === 'motion' || raw === 'free' || raw === 'nocost') return 'motion';
  if (raw === 'stock' || raw === 'real' || raw === 'footage') return 'stock';
  if (raw === 'hybrid' || raw === 'mixed') return 'hybrid';
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
  /**
   * What the caller promised. A MASTER job is refused rather than quietly
   * downgraded when no generative engine can run. Defaults to CANARY.
   */
  qualityTier?: QualityTier;
}

export interface VideoRenderResult {
  data: Buffer;
  /** Which engine produced the clip: `stock`, `comfyui`, `wan`, or the free `motion`. */
  engine: 'stock' | 'comfyui' | 'wan' | 'motion';
  /** What the bytes actually are, derived from the engine that made them. */
  mediaClass: MediaClass;
  /** The tier that was asked for, echoed back for the ledger. */
  qualityTier: QualityTier;
  /** Who shot the footage, when the clip came from a stock provider. */
  credit?: string;
  /** The source page for a stock clip, for attribution. */
  sourceUrl?: string;
  /** The licence the footage is under, when the provider states it. */
  licence?: string;
  /** Which engine edited it, when the editing pass ran. */
  editor?: 'opencut';
  /** A short human-readable note about the editing pass, for the logs. */
  editNote?: string;
  /**
   * The seed, dimensions and graph the clip was actually rendered with. Absent
   * for engines that expose none, so a stock clip does not claim a seed.
   */
  render?: ComfyRenderFacts;
  /**
   * How many calls left this machine to reach a third party. Loopback calls to
   * the local ComfyUI are not counted: no vendor sees them. The accounting
   * ledger is only honest if this number is measured, not assumed, so it is
   * counted around the real work rather than inferred from the engine name.
   */
  externalApiCalls: number;
  /** Wall-clock milliseconds this render actually took, including editing. */
  renderDurationMs: number;
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
  const qualityTier: QualityTier = input.qualityTier ?? 'CANARY';
  const startedAt = Date.now();
  // Every outbound call this render makes is counted inside this scope, so the
  // ledger reports a measured number instead of a guess.
  const { result, externalApiCalls } = await withExternalCallCounter(async () => {
    const raw = await generateRaw({ ...input, qualityTier });
    const edited = await maybeEdit(raw.data, input.editInstructions);
    return { ...raw, edited };
  });
  const { data, engine, credit, sourceUrl, licence, render, edited } = result;
  const renderDurationMs = Date.now() - startedAt;
  // The editing pass re-encodes but does not change what the motion is, so the
  // class stays with the engine that made it.
  const mediaClass = mediaClassForEngine(engine);
  // Belt and braces: the engines were filtered before the attempt, so a class the
  // tier refuses here means an engine slipped past the filter. Refuse the clip
  // rather than hand back something the tier never promised.
  const verdict = acceptsMediaClass(qualityTier, mediaClass);
  if (!verdict.accepted) {
    throw new MasterBackendBlocked(verdict.reason, qualityTier);
  }
  return {
    data: edited.data,
    engine,
    mediaClass,
    qualityTier,
    credit,
    sourceUrl,
    licence,
    editor: edited.editor,
    editNote: edited.note,
    render,
    renderDurationMs,
    externalApiCalls,
  };
}

/** True when the tier may use this engine at all, checked before any attempt. */
function engineAllowedForTier(engine: RenderEngine, tier: QualityTier): boolean {
  return enginesForTier(tier).includes(engine);
}

/**
 * The refusal a MASTER job gets when its generative engine cannot run.
 * `need` names what was required; `cause` says what actually failed, so the
 * operator is not left guessing.
 */
function masterRefusal(need: string, cause: string): MasterBackendBlocked {
  return new MasterBackendBlocked(`Kailangan ng ${need} para sa MASTER, ngunit ${cause}`, 'MASTER');
}

async function generateRaw(
  input: VideoRenderInput,
): Promise<{
  data: Buffer;
  engine: 'stock' | 'comfyui' | 'wan' | 'motion';
  credit?: string;
  sourceUrl?: string;
  licence?: string;
  render?: ComfyRenderFacts;
}> {
  const tier: QualityTier = input.qualityTier ?? 'CANARY';
  const mayUse = (engine: RenderEngine) => engineAllowedForTier(engine, tier);
  const preferred = preferredRenderEngine();

  // Real footage. A stock clip is a real camera pointed at real people, animals,
  // weather and places, which no generative model can claim. `hybrid` tries it
  // first and only falls through to the generated chain when there is no match.
  // A MASTER job skips this whole branch: stock footage is not this film's render.
  if ((preferred === 'stock' || preferred === 'hybrid') && !mayUse('stock')) {
    if (preferred === 'stock') {
      throw masterRefusal('comfyui', 'ang PREFERRED_RENDER_ENGINE=stock ay STOCK_FOOTAGE lamang');
    }
    console.log(`[RENDER] ${tier}: stock footage ay hindi tinatanggap, generated chain ang gagamitin.`);
  } else if (preferred === 'stock' || preferred === 'hybrid') {
    if (!stockConfigured()) {
      if (preferred === 'stock') {
        throw new VideoBackendUnavailable(
          'PREFERRED_RENDER_ENGINE=stock ngunit walang PEXELS_API_KEY o PIXABAY_API_KEY. ' +
            'Libre ang key sa pexels.com/api o pixabay.com/api/docs — walang GPU na kailangan.',
        );
      }
      console.log('[RENDER] hybrid: walang stock key, generated chain ang gagamitin.');
    } else {
      try {
        const clip = await fetchStockClip(input.prompt, input.seconds);
        if (clip) {
          const mp4 = await toMp4(clip.data);
          const providerName = clip.provider === 'pexels' ? 'Pexels'
            : clip.provider === 'pixabay' ? 'Pixabay' : 'Wikimedia Commons';
          console.log(
            `[RENDER] stock footage: ${clip.provider} #${clip.id} ni ${clip.author} ` +
              `(${(mp4.length / 1e6).toFixed(1)} MB, ${clip.licence || 'licence sa page'})`,
          );
          return {
            data: mp4,
            engine: 'stock',
            credit: `${clip.author} / ${providerName}`,
            sourceUrl: clip.pageUrl,
            licence: clip.licence,
          };
        }
      } catch (error: any) {
        console.log(`[RENDER] stock search nabigo: ${error?.message || error}`);
        if (preferred === 'stock') {
          throw new VideoBackendUnavailable(`stock footage: ${error?.message || error}`);
        }
      }
    }
  }

  // No cost: a free image, animated with ffmpeg. No cloud spend, no account.
  // Refused for a tier that will not accept still motion, before any work runs.
  if (preferred === 'motion') {
    if (!mayUse('motion')) {
      throw masterRefusal('comfyui', 'ang PREFERRED_RENDER_ENGINE=motion ay STILL_MOTION lamang');
    }
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
  if (comfyFailure.data) {
    return { data: comfyFailure.data, engine: 'comfyui', render: comfyFailure.render };
  }

  // Strict mode: the free engine would produce a still image with a ken-burns
  // pan — a real MP4, but not a real render, and it lands in the vault looking
  // like one. Wan 2.2 below is a genuine render, so it is still allowed.
  const strict = strictRealVideoOnly(preferred);
  if (strict) {
    console.warn(`[RENDER] STRICT_REAL_VIDEO_ONLY: hindi papayagan ang libreng motion engine (${comfyFailure.reason}).`);
  }

  // The free engine is the first thing that catches a missing ComfyUI: it needs
  // no key, no GPU and no account. A tier that will not accept still motion must
  // not take this branch at all: that is the numbered rule this policy exists for.
  if (!strict && mayUse('motion') && (await motionReady())) {
    try {
      const { data } = await generateMotionClip(input);
      console.log(
        `[RENDER] ComfyUI hindi available (${comfyFailure.reason}); libreng motion engine ang sumalo ` +
          `(${tier} ay tumatanggap ng STILL_MOTION).`,
      );
      return { data, engine: 'motion' };
    } catch (error: any) {
      console.log(`[RENDER] motion engine nabigo: ${error?.message || error}`);
    }
  } else if (!strict && !mayUse('motion')) {
    console.warn(
      `[RENDER] ${tier}: hindi papayagan ang libreng motion engine (STILL_MOTION), ` +
        `kahit na hindi available ang ComfyUI (${comfyFailure.reason}).`,
    );
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

  // Nothing real can render. In strict mode say exactly which Wan 2.2 weight is
  // absent, so the operator fixes .env instead of wondering why a clip is gone.
  if (strict) {
    const cause = wanConfigured() && !paidCloudAllowed()
      ? `${comfyFailure.reason}; at ${PAID_BLOCKED_DETAIL}`
      : `${comfyFailure.reason}; at walang FAL_KEY (Wan 2.2 fallback)`;
    const { detail, missing } = await strictRefusalDetail(cause);
    console.error(`[RENDER] STRICT_REAL_VIDEO_ONLY: ${detail}`);
    // A MASTER job must report the block, not a generic outage and not a Wan 2.2
    // weight complaint: what it needs is a generative backend, whatever the cause.
    if (!mayUse('motion')) {
      throw masterRefusal('comfyui o wan', cause);
    }
    throw new ComfyWan22Unavailable(detail, missing);
  }
  if (wanConfigured() && !paidCloudAllowed()) {
    throw new VideoBackendUnavailable(`${comfyFailure.reason}; at ${PAID_BLOCKED_DETAIL}`);
  }
  if (!falKeyConfigured()) {
    if (!mayUse('motion')) {
      throw masterRefusal('comfyui o wan', `${comfyFailure.reason}; at walang FAL_KEY (Wan 2.2 fallback)`);
    }
    throw new VideoBackendUnavailable(
      `${comfyFailure.reason}; at walang FAL_KEY (Wan 2.2 fallback)`,
    );
  }
  throw new VideoBackendUnavailable(`ComfyUI (${comfyFailure.reason}); Wan 2.2 fallback walang FAL_KEY`);
}

/** One ComfyUI attempt. Returns the clip, or the reason it could not render. */
async function comfyAttempt(
  input: VideoRenderInput,
): Promise<{ data?: Buffer; reason: string; render?: ComfyRenderFacts }> {
  const diagnosis = await diagnoseComfyVideo();
  if (!diagnosis.ready) {
    console.warn(`[RENDER] ComfyUI video backend hindi handa (${diagnosis.problem}): ${diagnosis.detail}`);
    return { reason: diagnosis.detail };
  }
  try {
    const { data, render } = await generateVideoWithComfy(input.prompt, { negative: input.negative });
    return { data, reason: '', render };
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
