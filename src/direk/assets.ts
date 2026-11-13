/**
 * Local asset store: keep every render on disk and hand back a download.
 *
 * This is the free replacement for Cloudinary (hosting) and Google Drive
 * (storage) from the skill registry. Files live in `assets/` next to the app,
 * each with a small JSON sidecar so we know what it is and where it came from.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createZip, type ZipEntry } from './zip.ts';

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
}

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

/** Save a buffer as an asset and return its metadata. */
export function saveAsset(
  data: Buffer,
  opts: { title: string; ext: string; mime: string; source: string; prompt?: string },
): AssetMeta {
  const dir = ensureDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `AST-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const name = `${stamp}_${slug(opts.title, 'asset')}.${opts.ext}`;
  fs.writeFileSync(path.join(dir, name), data);
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
  };
  fs.writeFileSync(path.join(dir, `${name}${SIDECAR_SUFFIX}`), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
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
  for (const meta of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, meta), 'utf8')) as AssetMeta);
    } catch {
      /* skip a corrupt sidecar rather than fail the listing */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
