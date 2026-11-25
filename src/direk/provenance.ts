/**
 * Provenance for every asset the app produces.
 *
 * A render is not just bytes: it is bytes plus the facts that make the bytes
 * auditable — which engine made it, which tier it had to satisfy, which seed and
 * resolution, whether the audio was really voiced, where the footage was
 * licensed from, and who decided to keep or drop it.
 *
 * Two rules shape this module:
 *
 * 1. Never invent a value. A field that was not recorded is left absent, not
 *    filled with a plausible guess. `unknown` means "we did not record this",
 *    and a legacy asset that never carried a seed must read as unknown rather
 *    than as seed 0.
 * 2. Never lose a decision. `SUPERSEDED` and `replacement_asset_id` exist so a
 *    re-render is a chain that can be walked, not a silent overwrite.
 */

import { createHash } from 'node:crypto';

/**
 * The seven review dispositions a vault asset can be in.
 *
 * The old model had three (`pending`/`approved`/`rejected`) and could not say
 * *why* something was rejected, nor separate a technical failure (bad bytes,
 * wrong backend) from a creative one (the shot is wrong for the film). Those are
 * different people's problems, so they are different dispositions.
 */
export type VaultDisposition =
  /** Waiting for a human. */
  | 'PENDING_REVIEW'
  /** Good enough to be the master copy of this shot. */
  | 'APPROVED_MASTER'
  /** Usable, but only to look at — never stitched into a master film. */
  | 'APPROVED_PREVIEW_ONLY'
  /** Plausible direction, wrong execution: re-render it, do not throw it away. */
  | 'REFINE'
  /** Broke a hard rule: corrupt, wrong media class, missing backend, blocked. */
  | 'REJECTED_TECHNICAL'
  /** Technically fine, but wrong for the film: tone, pacing, continuity. */
  | 'REJECTED_CREATIVE'
  /** Replaced by a newer asset; kept only so the chain is walkable. */
  | 'SUPERSEDED';

export const VAULT_DISPOSITIONS: VaultDisposition[] = [
  'PENDING_REVIEW',
  'APPROVED_MASTER',
  'APPROVED_PREVIEW_ONLY',
  'REFINE',
  'REJECTED_TECHNICAL',
  'REJECTED_CREATIVE',
  'SUPERSEDED',
];

/** Dispositions that let a scene be stitched into a film. */
export const STITCHABLE_DISPOSITIONS: VaultDisposition[] = ['APPROVED_MASTER'];

/** Dispositions that mean "no further action needed on this asset". */
export const SETTLED_DISPOSITIONS: VaultDisposition[] = [
  'APPROVED_MASTER',
  'APPROVED_PREVIEW_ONLY',
  'REJECTED_CREATIVE',
  'SUPERSEDED',
];

export function isVaultDisposition(raw: unknown): raw is VaultDisposition {
  return typeof raw === 'string' && (VAULT_DISPOSITIONS as string[]).includes(raw);
}

/**
 * The three old states, kept so existing callers, sidecars and the old review
 * buttons keep working. Each maps onto a disposition rather than being a
 * parallel vocabulary.
 */
export type LegacyReviewStatus = 'pending' | 'approved' | 'rejected';

export function legacyToDisposition(status: LegacyReviewStatus): VaultDisposition {
  if (status === 'approved') return 'APPROVED_MASTER';
  if (status === 'rejected') return 'REJECTED_CREATIVE';
  return 'PENDING_REVIEW';
}

/**
 * Map the short actions the UI and tests already send onto dispositions.
 * `reject` maps to creative because a bare "reject" from a reviewer was a
 * judgement about the film; a technical rejection states its reason.
 */
export function actionToDisposition(action: string): VaultDisposition | undefined {
  switch (action) {
    case 'approve':
    case 'approved':
    case 'APPROVED_MASTER':
      return 'APPROVED_MASTER';
    case 'preview':
    case 'APPROVED_PREVIEW_ONLY':
      return 'APPROVED_PREVIEW_ONLY';
    case 'refine':
    case 'REFINE':
      return 'REFINE';
    case 'reject':
    case 'rejected':
    case 'REJECTED_CREATIVE':
      return 'REJECTED_CREATIVE';
    case 'REJECTED_TECHNICAL':
      return 'REJECTED_TECHNICAL';
    case 'supersede':
    case 'SUPERSEDED':
      return 'SUPERSEDED';
    case 'pending':
    case 'PENDING_REVIEW':
      return 'PENDING_REVIEW';
    default:
      return undefined;
  }
}

/**
 * Accept anything a caller might reasonably send — a disposition, a legacy
 * status, or a short action — and return the disposition it means, or undefined
 * when it means nothing.
 */
export function normalizeDisposition(raw: unknown): VaultDisposition | undefined {
  if (typeof raw !== 'string') return undefined;
  return actionToDisposition(raw.trim());
}

/** Whether a disposition is one of the three legacy states, for backward compatibility views. */
export function dispositionToLegacy(disposition: VaultDisposition): LegacyReviewStatus {
  if (disposition === 'APPROVED_MASTER') return 'approved';
  if (
    disposition === 'APPROVED_PREVIEW_ONLY' ||
    disposition === 'REFINE' ||
    disposition === 'REJECTED_TECHNICAL' ||
    disposition === 'REJECTED_CREATIVE' ||
    disposition === 'SUPERSEDED'
  ) {
    return 'rejected';
  }
  return 'pending';
}

/** How the audio in this asset was produced. `none` means silent. */
export type AudioState = 'voiced' | 'silent' | 'music_only' | 'none';

/** What the licence of the source material allows, as stated by the provider. */
export interface SourceLicense {
  /** The raw licence string the provider gave, never paraphrased. */
  name: string;
  /** Where the licence and the attribution can be checked. */
  url?: string;
  /** Who must be credited. */
  credit?: string;
  /** True only when the licence was read from the provider, not assumed. */
  verified: boolean;
}

/**
 * Everything recorded about how one asset was made.
 *
 * Fields are optional because a real record is often partial: a stock clip has
 * no seed, an audio asset has no resolution, a legacy asset has neither. An
 * absent field is honest; a guessed one is not.
 */
export interface AssetProvenance {
  /** Which engine produced it: `comfyui`, `swarmui`, `wan`, `motion`, `stock`, `pollinations`, `gemini`. */
  backend?: string;
  /** What the bytes are, from the engine that made them. */
  mediaClass?: string;
  /** The tier the job promised and this asset had to satisfy. */
  qualityTier?: string;
  /**
   * The exact model, checkpoint or workflow this came from, so a re-render can
   * be reproduced. For ComfyUI this is the workflow file plus checkpoint.
   */
  modelOrWorkflowVersion?: string;
  /** SHA-256 of the prompt that was sent, not the prompt itself. */
  promptHash?: string;
  /** The seed actually used. Absent when the engine did not report one. */
  seed?: number;
  /**
   * Every seed used, when an asset was assembled from several renders (a scene
   * is cut into shots and each shot is rendered once). `seed` is only set when
   * there is exactly one, because a single number cannot describe a cut.
   */
  seeds?: number[];
  /** Pixel dimensions as rendered, e.g. `1280x720`. */
  resolution?: string;
  /** Length and frame count, as measured from the finished file. */
  framesDuration?: { frames?: number; seconds?: number; fps?: number };
  /** Whether this asset carries narration, music, both, or nothing. */
  audioState?: AudioState;
  /** Licence of the source material, when the material was not made here. */
  sourceLicense?: SourceLicense;
  /** Who last reviewed it (a name or handle, never an email password). */
  reviewer?: string;
  /** Why the disposition was chosen, in the reviewer's words. */
  reason?: string;
  /** The asset this one was re-rendered from, when it replaces another. */
  parentAssetId?: string;
  /** The asset that replaced this one, set when this one is SUPERSEDED. */
  replacementAssetId?: string;
  /** SHA-256 of the asset bytes. */
  checksum?: string;
}

/**
 * Section 7 grounding declaration.
 *
 * The reference catalog is used to benchmark genre and pacing. It is explicitly
 * not a source of protected scripts, characters, dialogue or shot lists. This
 * record is written next to every generated asset so the claim travels with the
 * file instead of living only in a document nobody opens.
 */
export interface OriginalityProvenance {
  /** True only when the grounding datasets were actually consulted. */
  groundingUsed: boolean;
  /** What the grounding was consulted for. Never "plot" or "dialogue". */
  groundingPurpose: ('genre_benchmark' | 'pacing_benchmark' | 'market_benchmark')[];
  /** The catalog genre matched, when one matched. */
  groundingGenre?: string;
  /** How many reference titles were consulted. A count, never the titles. */
  referenceCount: number;
  /**
   * The declaration itself. Stored as a sentence so a reader does not have to
   * interpret a boolean: this is the claim being made about the asset.
   */
  declaration: string;
  /**
   * What was NOT taken from the references. Kept explicit because the negative
   * claim is the one that matters legally.
   */
  notDerived: ('script' | 'characters' | 'dialogue' | 'shot_list' | 'music' | 'visual_style')[];
  /** True when a human reviewed the asset against this declaration. */
  humanReviewed: boolean;
}

/** The declaration text used when grounding was consulted. */
export const ORIGINALITY_DECLARATION_GROUNDED =
  'Ang asset na ito ay orihinal na ginawa. Ang reference catalog ay ginamit lamang ' +
  'para sa genre at pacing benchmark; walang script, karakter, dialogue, shot list, ' +
  'musika o visual style na kinopya mula sa anumang protektadong gawa.';

/** The declaration text used when no grounding was consulted at all. */
export const ORIGINALITY_DECLARATION_UNGOUNDED =
  'Ang asset na ito ay orihinal na ginawa nang walang reference catalog grounding. ' +
  'Walang script, karakter, dialogue, shot list, musika o visual style na kinopya ' +
  'mula sa anumang protektadong gawa.';

/**
 * Build the originality record for a render.
 *
 * `grounding` is what the screenplay actually consulted, so an asset made from a
 * brief that matched no catalog genre records `groundingUsed: false` rather than
 * claiming grounding that never happened.
 */
export function originalityProvenance(grounding?: {
  genre?: string | null;
  referenceCount?: number;
  usedFor?: ('genre_benchmark' | 'pacing_benchmark' | 'market_benchmark')[];
}): OriginalityProvenance {
  const referenceCount = grounding?.referenceCount ?? 0;
  const grounded = Boolean(grounding?.genre) && referenceCount > 0;
  return {
    groundingUsed: grounded,
    groundingPurpose: grounded ? (grounding?.usedFor ?? ['genre_benchmark', 'pacing_benchmark']) : [],
    groundingGenre: grounding?.genre ?? undefined,
    referenceCount,
    declaration: grounded ? ORIGINALITY_DECLARATION_GROUNDED : ORIGINALITY_DECLARATION_UNGOUNDED,
    notDerived: ['script', 'characters', 'dialogue', 'shot_list', 'music', 'visual_style'],
    humanReviewed: false,
  };
}

/** SHA-256 of a prompt, so a sidecar can prove which prompt produced the bytes. */
export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}
