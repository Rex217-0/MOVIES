/**
 * Local render store: the served home for finished `.mp4` files.
 *
 * Feature Film Factory renders (the 18 scenes and the stitched feature) are
 * written to `public/renders/`, which the server exposes at `/renders/<name>`.
 * That keeps the files downloadable and playable straight from the browser.
 *
 * Like `factoryDb.ts`, this is the local stand-in for hosted object storage
 * (e.g. a cloud bucket). The three functions below are the whole seam, so a
 * managed backend can replace them without touching the batch engine.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where renders live. `DIREK_RENDERS_DIR` overrides it (used by tests). */
export function rendersDir(): string {
  return process.env.DIREK_RENDERS_DIR || path.join(process.cwd(), 'public', 'renders');
}

/** The public URL a stored render is served from. */
export function renderUrl(name: string): string {
  return `/renders/${encodeURIComponent(name)}`;
}

function slug(text: string, fallback: string): string {
  const base = (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || fallback;
}

export interface StoredRender {
  name: string;
  path: string;
  url: string;
  bytes: number;
}

/** Write a render into `public/renders/` and return where it can be fetched. */
export function saveRender(data: Buffer, title: string, ext = 'mp4'): StoredRender {
  const dir = rendersDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}_${slug(title, 'render')}.${ext}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, data);
  return { name, path: full, url: renderUrl(name), bytes: data.length };
}

/** Resolve a stored render to an absolute path, refusing to leave the folder. */
export function renderPath(name: string): string | null {
  const dir = path.resolve(rendersDir());
  const full = path.resolve(dir, name);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  return fs.existsSync(full) ? full : null;
}

/** Every stored render name, newest first. */
export function listRenders(): string[] {
  try {
    return fs
      .readdirSync(rendersDir())
      .filter(f => f.endsWith('.mp4'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
