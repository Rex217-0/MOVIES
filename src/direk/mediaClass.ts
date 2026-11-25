/**
 * What a clip actually is, and what a job is allowed to accept.
 *
 * Two separate questions, kept in one module so they cannot drift apart:
 *
 *   media_class   What the bytes on disk are. A generative model, a still
 *                 picture panned by ffmpeg, real stock footage, or a mix.
 *   quality_tier  What the job promised to deliver. A MASTER job promised a
 *                 synthetic render, so a still-motion clip cannot satisfy it.
 *
 * The rule this module exists to enforce: a render is never reported as
 * something it is not. Before this, every MP4 was "video success", so a
 * ken-burns pan of a still image and a Wan 2.2 render were indistinguishable in
 * the vault and in the API. A MASTER job that could not reach ComfyUI went
 * quietly to still-motion and looked like a success.
 *
 * The refusal is a real state, not an error string: `BLOCKED` with the code
 * `REQUIRED_MASTER_BACKEND_UNAVAILABLE`. That is checkable by the caller, by the
 * database, and by a test.
 *
 * This module is pure: it imports nothing from the render service, so the render
 * service can import it without a cycle.
 */

/** What a rendered asset is. Never inferred from the file extension. */
export type MediaClass =
  /** A generative model made the motion (ComfyUI, Wan 2.2, SVD, AnimateDiff). */
  | 'SYNTHETIC_MOTION'
  /** A still picture moved by ffmpeg (ken-burns pan/zoom). A real MP4, not a render. */
  | 'STILL_MOTION'
  /** A real camera pointed at the world: Pexels, Pixabay, Wikimedia. */
  | 'STOCK_FOOTAGE'
  /** More than one class in one asset (stock cut with generated, say). */
  | 'HYBRID'
  /** Nothing usable was produced. */
  | 'FAILED';

/** What a job promised. Set when the job is created, never changed after. */
export type QualityTier = 'CANARY' | 'PREVIEW' | 'MASTER';

/** The engines the render service can actually produce. */
export type RenderEngine = 'stock' | 'comfyui' | 'wan' | 'motion';

/**
 * The job's terminal state when a required backend is missing.
 *
 * `BLOCKED` is deliberately not `failed`: a failure is the engine trying and
 * falling over, a block is the policy refusing to substitute something weaker.
 * The operator fixes a block by starting ComfyUI; they fix a failure by reading
 * the error.
 */
export const BLOCKED_MASTER_BACKEND = 'BLOCKED: REQUIRED_MASTER_BACKEND_UNAVAILABLE';

/** The machine-readable half of the block, for JSON replies. */
export const MASTER_BACKEND_UNAVAILABLE_CODE = 'REQUIRED_MASTER_BACKEND_UNAVAILABLE';

/** Every quality tier, in the order the UI should offer them. */
export const QUALITY_TIERS: QualityTier[] = ['CANARY', 'PREVIEW', 'MASTER'];

/** Every media class, for the UI and the vault filter. */
export const MEDIA_CLASSES: MediaClass[] = [
  'SYNTHETIC_MOTION', 'STILL_MOTION', 'STOCK_FOOTAGE', 'HYBRID', 'FAILED',
];

/**
 * What each engine produces. This is the only place the mapping lives: an
 * engine that starts dodging it would be a new engine, not a reclassification.
 */
export const ENGINE_MEDIA_CLASS: Record<RenderEngine, MediaClass> = {
  comfyui: 'SYNTHETIC_MOTION',
  wan: 'SYNTHETIC_MOTION',
  motion: 'STILL_MOTION',
  stock: 'STOCK_FOOTAGE',
};

/**
 * The media class for a finished clip. `HYBRID` is never inferred from a single
 * engine: it is only correct when the caller says two sources were combined, so
 * it must be asked for explicitly rather than guessed.
 */
export function mediaClassForEngine(engine: string, opts: { hybrid?: boolean } = {}): MediaClass {
  if (opts.hybrid) return 'HYBRID';
  const mapped = ENGINE_MEDIA_CLASS[engine as RenderEngine];
  if (mapped) return mapped;
  // An unknown engine cannot be vouched for. Calling it SYNTETIC would be a
  // claim about bytes we did not make, so it is a failure by definition.
  return 'FAILED';
}

/**
 * Which media classes each tier accepts.
 *
 * CANARY proves the pipeline end to end, so anything real is enough.
 * PREVIEW may use any approved preview engine, which includes still motion.
 * MASTER is a promise of generative motion: a still pan does not satisfy it, and
 * neither does stock footage, because a master render is this film's own image.
 */
export const TIER_ACCEPTS: Record<QualityTier, MediaClass[]> = {
  CANARY: ['SYNTHETIC_MOTION', 'STILL_MOTION', 'STOCK_FOOTAGE', 'HYBRID'],
  PREVIEW: ['SYNTHETIC_MOTION', 'STILL_MOTION', 'HYBRID'],
  MASTER: ['SYNTHETIC_MOTION'],
};

/** Why a tier refuses a class, in the operator's language. */
const REFUSAL_REASON: Record<MediaClass, string> = {
  SYNTHETIC_MOTION: '',
  STILL_MOTION:
    'STILL_MOTION ay isang still na pinagalaw ng ffmpeg (ken-burns), hindi generative render.',
  STOCK_FOOTAGE:
    'STOCK_FOOTAGE ay kuha ng ibang camera, hindi sariling render ng pelikulang ito.',
  HYBRID: 'HYBRID ay halu ng mga source, kaya hindi ito purong synthetic render.',
  FAILED: 'FAILED ang render: walang gumaganang backend.',
};

export interface AcceptanceVerdict {
  accepted: boolean;
  tier: QualityTier;
  mediaClass: MediaClass;
  /** True only when the job must stop rather than run a weaker engine. */
  blocked: boolean;
  /** A operator-readable explanation. Empty when accepted. */
  reason: string;
}

/**
 * Does this tier accept this media class? The one decision every render passes
 * through, so the answer cannot differ between the API, the vault and the logs.
 */
export function acceptsMediaClass(tier: QualityTier, mediaClass: MediaClass): AcceptanceVerdict {
  const accepts = TIER_ACCEPTS[tier] || TIER_ACCEPTS.CANARY;
  if (accepts.includes(mediaClass)) {
    return { accepted: true, tier, mediaClass, blocked: false, reason: '' };
  }
  return {
    accepted: false,
    tier,
    mediaClass,
    blocked: true,
    reason: `${tier} ay tumatanggap lamang ng ${accepts.join(' o ')}. ${REFUSAL_REASON[mediaClass]}`
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

/**
 * The engines a tier may use at all, before any attempt is made.
 *
 * A MASTER job must not even try the still-motion engine: trying it costs GPU
 * time and writes a file that then has to be thrown away. Checking first turns a
 * silent downgrade into a refusal before any render starts.
 */
export function enginesForTier(tier: QualityTier): RenderEngine[] {
  const allowed: RenderEngine[] = [];
  for (const engine of Object.keys(ENGINE_MEDIA_CLASS) as RenderEngine[]) {
    if ((TIER_ACCEPTS[tier] || TIER_ACCEPTS.CANARY).includes(ENGINE_MEDIA_CLASS[engine])) {
      allowed.push(engine);
    }
  }
  return allowed;
}

/** True when a tier can only be satisfied by a local generative GPU render. */
export function requiresMasterBackend(tier: QualityTier): boolean {
  return tier === 'MASTER';
}

/** A quality tier from untrusted input, defaulting to the safest useful value. */
export function parseQualityTier(raw: unknown): QualityTier {
  const value = String(raw ?? '').trim().toUpperCase();
  return (QUALITY_TIERS as string[]).includes(value) ? (value as QualityTier) : 'CANARY';
}

/**
 * The refusal a MASTER job gets when no generative backend can run.
 *
 * It names the tier, the missing engine, and the two honest ways forward. It
 * never suggests falling back to still motion, because that is the exact
 * substitution this module exists to prevent.
 */
export function masterBackendBlockedDetail(detail: string): string {
  return [
    BLOCKED_MASTER_BACKEND,
    'Ang MASTER job ay nangangailangan ng generative na render (ComfyUI o Wan 2.2),',
    'at hindi available ngayon:',
    detail.replace(/\.$/, '') + '.',
    'Hindi ito bababa sa STILL_MOTION, dahil hindi iyon katumbas ng synthetic render.',
    'Ayusin: patakbuhin ang ComfyUI at siguraduhing kumpleto ang Wan 2.2 weights,',
    'o gumawa ng PREVIEW/CANARY job kung sadyang pansamantala lang ang render.',
  ].join(' ');
}

/**
 * The refusal text when a render threw instead of returning a refused class.
 *
 * The engine can refuse two ways: hand back bytes and let the caller judge the
 * class, or throw because no acceptable engine exists at all. The second must
 * still land as a policy block, never as a generic "nabigo ang render", or an
 * operator would read a deliberate stand-down as a crash and simply re-run it.
 */
export function masterRefusalReason(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code !== MASTER_BACKEND_UNAVAILABLE_CODE) return undefined;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : masterBackendBlockedDetail('walang detalye');
}
