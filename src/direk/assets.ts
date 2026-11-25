/**
 * Local asset store: keep every render on disk and hand back a download.
 *
 * This is the free replacement for Cloudinary (hosting) and Google Drive
 * (storage) from the skill registry. Files live in `assets/` next to the app,
 * each with a small JSON sidecar so we know what it is and where it came from.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createZip, type ZipEntry } from './zip.ts';
import type { MediaClass, QualityTier } from './mediaClass.ts';
import {
  dispositionToLegacy,
  isVaultDisposition,
  legacyToDisposition,
  normalizeDisposition,
  originalityProvenance,
  promptHash,
  type AssetProvenance,
  type AudioState,
  type LegacyReviewStatus,
  type OriginalityProvenance,
  type SourceLicense,
  type VaultDisposition,
} from './provenance.ts';

export interface AssetMeta {
  id: string;
  name: string;
  ext: string;
  mime: string;
  bytes: number;
  kind: 'video' | 'image' | 'audio' | 'other';
  title: string;
  prompt?: string;
  source: string;
  createdAt: string;
  /**
   * The short review view of `disposition`, kept for the old review buttons and
   * for sidecars written before dispositions existed. `disposition` is the
   * record of truth; this is derived from it on every write.
   */
  reviewStatus?: LegacyReviewStatus;
  /** The authoritative review state. Every asset has one. */
  disposition: VaultDisposition;
  /**
   * What these bytes are. Absent on assets written before this field existed,
   * which is why `listAssets` never invents a value for an old row.
   */
  mediaClass?: MediaClass;
  /** The tier the job promised, so the vault can show what it has to satisfy. */
  qualityTier?: QualityTier;
  /** Which engine made it (`comfyui`, `wan`, `motion`, `stock`). */
  backend?: string;
  /** SHA-256 of the file, so a review can prove the bytes did not change. */
  checksum?: string;
  /** The model, checkpoint or workflow this came from, so it can be reproduced. */
  modelOrWorkflowVersion?: string;
  /** SHA-256 of the prompt, not the prompt itself. */
  promptHash?: string;
  /** The seed actually reported by the engine. Absent when it reported none. */
  seed?: number;
  /** Every seed used, when the asset is an assembly of several renders. */
  seeds?: number[];
  /** Pixel dimensions as rendered, e.g. `1280x720`. */
  resolution?: string;
  /** Length and frame count, as measured from the finished file. */
  framesDuration?: { frames?: number; seconds?: number; fps?: number };
  /** Whether this asset carries narration, music, both, or nothing. */
  audioState?: AudioState;
  /** Licence of source material, when the material was not made here. */
  sourceLicense?: SourceLicense;
  /** Who last reviewed it. */
  reviewer?: string;
  /** Why that disposition was chosen. */
  reason?: string;
  /** The asset this one was re-rendered from. */
  parentAssetId?: string;
  /** The asset that replaced this one, set when this one is superseded. */
  replacementAssetId?: string;
  /** Section 7 grounding declaration, written next to the bytes. */
  originality?: OriginalityProvenance;
}

/**
 * The legacy three-state view. Kept as an alias so callers that only speak
 * `pending`/`approved`/`rejected` keep compiling and keep working.
 */
export type ReviewStatus = LegacyReviewStatus;


/** Sidecars carry this suffix so a `.json` asset is never mistaken for one. */
export const SIDECAR_SUFFIX = '.asset.json';

export function assetsDir(): string {
  return process.env.DIREK_ASSETS_DIR || path.join(process.cwd(), 'assets');
}

function ensureDir(): string {
  const dir = assetsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function kindOf(ext: string): AssetMeta['kind'] {
  if (/^(mp4|webm|mov|mkv)$/i.test(ext)) return 'video';
  if (/^(png|jpg|jpeg|webp|gif)$/i.test(ext)) return 'image';
  if (/^(mp3|wav|m4a|aac)$/i.test(ext)) return 'audio';
  return 'other';
}

/** SHA-256 of the bytes, so a sidecar can prove the file on disk is the one reviewed. */
export function checksumOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function slug(text: string, fallback: string): string {
  const base = (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || fallback;
}

/** Write a sidecar atomically, so a crash mid-write cannot corrupt an asset's record. */
function writeSidecar(file: string, meta: AssetMeta): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Save a buffer as an asset and return its metadata. */
export function saveAsset(
  data: Buffer,
  opts: {
    title: string;
    ext: string;
    mime: string;
    source: string;
    prompt?: string;
    mediaClass?: MediaClass;
    qualityTier?: QualityTier;
    backend?: string;
    /** Everything else recorded about how this asset was made. */
    provenance?: AssetProvenance;
    /** The Section 7 grounding declaration for this asset. */
    originality?: OriginalityProvenance;
    /** Where this asset sits in the review flow. Defaults to PENDING_REVIEW. */
    disposition?: VaultDisposition;
  },
): AssetMeta {
  const dir = ensureDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `AST-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  // Two renders of the same scene in the same millisecond would otherwise share
  // a name, and the second write would destroy the first — the exact asset the
  // supersede chain is supposed to preserve. Keep the stamp for readability and
  // add a counter only when the name is already taken.
  const base = `${stamp}_${slug(opts.title, 'asset')}`;
  let name = `${base}.${opts.ext}`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) {
    name = `${base}-${n}.${opts.ext}`;
  }
  const checksum = checksumOf(data);
  fs.writeFileSync(path.join(dir, name), data);
  const prov = opts.provenance ?? {};
  const disposition = opts.disposition ?? 'PENDING_REVIEW';
  const meta: AssetMeta = {
    id,
    name,
    ext: opts.ext,
    mime: opts.mime,
    bytes: data.length,
    kind: kindOf(opts.ext),
    title: opts.title || 'Walang pamagat',
    prompt: opts.prompt,
    source: opts.source,
    createdAt: new Date().toISOString(),
    disposition,
    // Derived, never independently set: one write path keeps the two views
    // from drifting apart.
    reviewStatus: dispositionToLegacy(disposition),
    mediaClass: opts.mediaClass ?? (prov.mediaClass as MediaClass | undefined),
    qualityTier: opts.qualityTier ?? (prov.qualityTier as QualityTier | undefined),
    backend: opts.backend ?? prov.backend,
    // The checksum is measured from the bytes, so a caller cannot write a
    // checksum that does not match the file it is describing.
    checksum,
    modelOrWorkflowVersion: prov.modelOrWorkflowVersion,
    promptHash: prov.promptHash ?? (opts.prompt ? promptHash(opts.prompt) : undefined),
    seed: prov.seed,
    seeds: prov.seeds,
    resolution: prov.resolution,
    framesDuration: prov.framesDuration,
    audioState: prov.audioState,
    sourceLicense: prov.sourceLicense,
    reviewer: prov.reviewer,
    reason: prov.reason,
    parentAssetId: prov.parentAssetId,
    replacementAssetId: prov.replacementAssetId,
    // An asset with no grounding record states that honestly rather than
    // omitting the field and looking like an oversight.
    originality: opts.originality ?? originalityProvenance(),
  };
  writeSidecar(path.join(dir, `${name}${SIDECAR_SUFFIX}`), meta);
  return meta;
}

/**
 * Read one sidecar and normalise it into the current shape.
 *
 * Sidecars written before dispositions existed carry only `reviewStatus`. The
 * backfill is deterministic — a missing disposition is derived from the legacy
 * field — and it is *not* invented: an asset that was never reviewed is
 * PENDING_REVIEW because that is what "no review yet" has always meant.
 */
function readSidecar(dir: string, file: string): AssetMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as AssetMeta;
    if (isVaultDisposition(parsed.disposition)) return parsed;
    const legacy: LegacyReviewStatus = parsed.reviewStatus ?? 'pending';
    const disposition = legacyToDisposition(legacy);
    return { ...parsed, disposition, reviewStatus: legacy };
  } catch {
    /* skip a corrupt sidecar rather than fail the listing */
    return null;
  }
}

/** Every asset, newest first. */
export function listAssets(): AssetMeta[] {
  const dir = assetsDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(f => f.endsWith(SIDECAR_SUFFIX));
  } catch {
    return [];
  }
  const out: AssetMeta[] = [];
  for (const file of names) {
    const meta = readSidecar(dir, file);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One asset by id or name, with the same legacy backfill as `listAssets`. */
export function findAsset(idOrName: string): AssetMeta | null {
  return listAssets().find(a => a.id === idOrName || a.name === idOrName) ?? null;
}

/**
 * Set the review disposition of one asset and rewrite its sidecar.
 *
 * `reviewer` and `reason` are recorded because a disposition without a reason is
 * not auditable: six months later nobody can tell a technical rejection from a
 * creative one except by the note left with it.
 *
 * Returns the updated metadata, or null when no asset carries that id (or name),
 * so the caller can answer 404 instead of pretending it worked.
 */
export function reviewAsset(
  idOrName: string,
  dispositionOrLegacy: VaultDisposition | LegacyReviewStatus | string,
  opts: { reviewer?: string; reason?: string; replacementAssetId?: string } = {},
): AssetMeta | null {
  const disposition = normalizeDisposition(dispositionOrLegacy);
  // An unrecognised state is refused rather than stored, so a typo cannot write
  // a disposition the vault cannot render or the stitcher cannot read.
  if (!disposition) return null;
  const target = findAsset(idOrName);
  if (!target) return null;
  const updated: AssetMeta = {
    ...target,
    disposition,
    reviewStatus: dispositionToLegacy(disposition),
    reviewer: opts.reviewer ?? target.reviewer,
    reason: opts.reason ?? target.reason,
    replacementAssetId: opts.replacementAssetId ?? target.replacementAssetId,
    // A human looked at this asset and judged it, which is exactly what the
    // originality declaration needs to stop saying "not yet reviewed".
    originality: target.originality
      ? { ...target.originality, humanReviewed: true }
      : undefined,
  };
  writeSidecar(path.join(assetsDir(), `${target.name}${SIDECAR_SUFFIX}`), updated);
  return updated;
}

/**
 * Mark an asset as replaced by a newer one.
 *
 * The old asset is kept, never deleted: a superseded render is evidence of what
 * was rejected and why, and deleting it would break the chain that
 * `replacement_asset_id` exists to record.
 */
export function supersedeAsset(
  idOrName: string,
  replacementAssetId: string,
  opts: { reviewer?: string; reason?: string } = {},
): AssetMeta | null {
  return reviewAsset(idOrName, 'SUPERSEDED', {
    reviewer: opts.reviewer,
    reason: opts.reason ?? `Pinalitan ng asset ${replacementAssetId}.`,
    replacementAssetId,
  });
}

/** Resolve an asset name to an absolute path, refusing to leave the store. */
export function assetPath(name: string): string | null {
  const dir = path.resolve(assetsDir());
  const full = path.resolve(dir, name);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}

/** Delete an asset and its sidecar. */
export function deleteAsset(name: string): boolean {
  const full = assetPath(name);
  if (!full) return false;
  fs.rmSync(full, { force: true });
  fs.rmSync(`${full}${SIDECAR_SUFFIX}`, { force: true });
  return true;
}

/** Bundle the chosen assets, or all of them, into one ZIP. */
export function bundleAssets(names?: string[]): Buffer {
  const all = listAssets();
  const chosen = names?.length ? all.filter(a => names.includes(a.name)) : all;
  const entries: ZipEntry[] = [];
  for (const asset of chosen) {
    const full = assetPath(asset.name);
    if (full) entries.push({ name: asset.name, data: fs.readFileSync(full) });
  }
  const manifest = chosen
    .map(a => `${a.name}\t${a.kind}\t${a.bytes} bytes\t${a.source}\t${a.title}`)
    .join('\n');
  entries.push({ name: 'MANIFEST.txt', data: Buffer.from(manifest + '\n', 'utf8') });
  return createZip(entries);
}
