/**
 * Free connectors: real, local implementations for every skill the registry
 * used to only name.
 *
 * The skill registry lists paid cloud services (Cloudinary, Picsart, OpusClip,
 * Descript, HeyGen, vidIQ, Tracy, Tella, Orshot, Google Drive). None of them is
 * called here. Instead each skill maps to a local job that produces the same
 * kind of result for free: ffmpeg for edits and clips, the asset store for
 * hosting and storage, and the SEO builder for growth and audience work.
 *
 * `publish_post` still asks for confirmation, and it still does not upload
 * anywhere: it builds a ready-to-publish bundle (vertical cut, poster, captions,
 * metadata) that you post yourself.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveAsset, listAssets, deleteAsset, bundleAssets, assetPath, type AssetMeta } from './assets.ts';
import { buildSeoPack } from './seo.ts';
import {
  colorGrade, trimVideo, toVertical, addText, poster, thumbnail,
  concatVideos, imageToVideo, kenBurnsClip, probe, type GradePreset,
} from './render.ts';
import { imagine } from './imagine.ts';
import { driveConfigured, readTokens, uploadFile, listDriveFiles } from './gdrive.ts';

export interface ConnectorResult {
  skill: string;
  ok: boolean;
  note: string;
  assets: AssetMeta[];
  download?: { name: string; mime: string; data: Buffer };
  data?: unknown;
}

type Args = Record<string, unknown>;

const str = (a: Args, k: string): string => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');
const num = (a: Args, k: string, d: number): number => {
  const n = Number(a[k]);
  return Number.isFinite(n) ? n : d;
};

function tmpFile(ext: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direk-conn-'));
  return path.join(dir, `src.${ext}`);
}

/**
 * Turn whatever the model referenced into a real local file: an asset name, a
 * data URL, a remote URL, or an existing path.
 */
export async function resolveSource(ref: string): Promise<string> {
  if (!ref) throw new Error('Kailangan ng source file (asset name, URL, o path).');

  if (ref.startsWith('data:')) {
    const comma = ref.indexOf(',');
    const header = ref.slice(5, comma);
    const ext = header.includes('png') ? 'png' : header.includes('jpeg') ? 'jpg' : header.includes('webp') ? 'webp' : 'mp4';
    const file = tmpFile(ext);
    fs.writeFileSync(file, Buffer.from(ref.slice(comma + 1), 'base64'));
    return file;
  }

  const local = assetPath(ref) || (fs.existsSync(ref) ? ref : null);
  if (local) return local;

  if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Hindi makuha ang source (${res.status}).`);
    const ext = (ref.split('.').pop() || 'mp4').split('?')[0].slice(0, 4) || 'mp4';
    const file = tmpFile(ext);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  }

  throw new Error(`Hindi mahanap ang source na '${ref}'.`);
}

function isImageFile(file: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(file);
}

/**
 * Resolve a reference to a real image file. When it is not a file, a data URL
 * or a remote URL, it is treated as a prompt and the image is generated, so a
 * poster request that only carries a description still works.
 */
async function toImageFile(ref: string, title: string): Promise<string> {
  const local = assetPath(ref) || (fs.existsSync(ref) ? ref : null);
  if (local) return local;
  if (/^https?:\/\//i.test(ref) || ref.startsWith('data:')) return resolveSource(ref);
  const generated = await imagine(ref);
  return tmpWrite(generated.data, 'png');
}

/**
 * Resolve a reference to a video file. A still image becomes a short ken-burns
 * clip, and a plain description is generated as an image first, so "edit this"
 * works even when the model only handed over a prompt.
 */
async function toVideoFile(ref: string, title: string): Promise<string> {
  const local = assetPath(ref) || (fs.existsSync(ref) ? ref : null);
  const file = local || (ref.startsWith('data:') || /^https?:\/\//i.test(ref) ? await resolveSource(ref) : await toImageFile(ref, title));
  if (isImageFile(file)) return kenBurnsClip(file, 3);
  return file;
}

async function save(data: Buffer, ext: string, mime: string, title: string, source: string, prompt?: string): Promise<AssetMeta> {
  return saveAsset(data, { title, ext, mime, source, prompt });
}

/** Cut a long clip into short vertical clips, ready for Reels or Shorts. */
async function shortClips(a: Args): Promise<ConnectorResult> {
  const source = await toVideoFile(str(a, 'source'), str(a, 'title') || 'Short');
  const count = Math.max(1, Math.min(10, Math.round(num(a, 'count', 3))));
  const seconds = Math.max(3, Math.min(60, Math.round(num(a, 'seconds', 15))));
  const title = str(a, 'title') || 'Short';
  const info = await probe(source);
  const total = info.duration || count * seconds;
  const assets: AssetMeta[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.min(i * seconds, Math.max(0, total - seconds));
    const cut = await trimVideo(source, start, seconds);
    const vertical = await toVertical(cut.data ? tmpWrite(cut.data, 'mp4') : source);
    assets.push(await save(vertical.data, 'mp4', 'video/mp4', `${title} clip ${i + 1}`, 'short_clips'));
  }
  return {
    skill: 'short_clips',
    ok: true,
    note: `${assets.length} vertical clip(s) gawa locally, ${seconds}s bawat isa.`,
    assets,
    download: { name: `${slug(title)}-clips.zip`, mime: 'application/zip', data: bundleAssets(assets.map(x => x.name)) },
  };
}

function tmpWrite(data: Buffer, ext: string): string {
  const file = tmpFile(ext);
  fs.writeFileSync(file, data);
  return file;
}

function slug(text: string): string {
  return (text || 'asset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'asset';
}

/** A produced short: vertical cut, cinematic grade, title burned in. */
async function autoProducer(a: Args): Promise<ConnectorResult> {
  const source = await toVideoFile(str(a, 'source'), str(a, 'title') || 'Orihinal na Pelikula');
  const title = str(a, 'title') || 'Orihinal na Pelikula';
  const vertical = await toVertical(source);
  const graded = await colorGrade(tmpWrite(vertical.data, 'mp4'), 'cinematic');
  const titled = await addText(tmpWrite(graded.data, 'mp4'), title, { placement: 'bottom' });
  const asset = await save(titled.data, 'mp4', 'video/mp4', `${title} (produced short)`, 'auto_producer');
  const cover = await poster(title, { subtitle: str(a, 'subtitle'), background: await firstFrame(tmpWrite(titled.data, 'mp4')) });
  const coverAsset = await save(cover.data, 'png', 'image/png', `${title} cover`, 'auto_producer');
  return {
    skill: 'auto_producer',
    ok: true,
    note: 'Produced short: 9:16, cinematic grade, may title at cover.',
    assets: [asset, coverAsset],
    download: { name: `${slug(title)}-produced.zip`, mime: 'application/zip', data: bundleAssets([asset.name, coverAsset.name]) },
  };
}

async function firstFrame(video: string): Promise<string | undefined> {
  try {
    const png = await thumbnail(video, 0.5);
    return tmpWrite(png.data, 'png');
  } catch {
    return undefined;
  }
}

/** The publish bundle: everything a post needs, in one download. */
async function publishPost(a: Args): Promise<ConnectorResult> {
  const title = str(a, 'title') || 'Bagong Pelikula';
  const source = str(a, 'source');
  const assets: AssetMeta[] = [];

  if (source) {
    const file = await resolveSource(source);
    const vertical = await toVertical(file);
    assets.push(await save(vertical.data, 'mp4', 'video/mp4', `${title} (9:16)`, 'publish_post'));
  }

  const seo = buildSeoPack(title, {
    logline: str(a, 'logline'),
    keywords: Array.isArray(a.keywords) ? (a.keywords as unknown[]).map(String) : [],
    mood: str(a, 'mood'),
    durationSeconds: num(a, 'durationSeconds', 0),
  });

  const cover = await poster(title, { subtitle: seo.thumbnailText });
  assets.push(await save(cover.data, 'png', 'image/png', `${title} poster`, 'publish_post'));
  assets.push(await save(Buffer.from(JSON.stringify(seo, null, 2), 'utf8'), 'json', 'application/json', `${title} metadata`, 'publish_post'));

  return {
    skill: 'publish_post',
    ok: true,
    note: 'Publish bundle: 9:16 cut, poster, at metadata. Ikaw ang mag-upload.',
    assets,
    data: seo,
    download: { name: `${slug(title)}-publish.zip`, mime: 'application/zip', data: bundleAssets(assets.map(x => x.name)) },
  };
}

async function seoPack(a: Args, skill: string): Promise<ConnectorResult> {
  const title = str(a, 'title') || 'Bagong Pelikula';
  const seo = buildSeoPack(title, {
    logline: str(a, 'logline'),
    keywords: Array.isArray(a.keywords) ? (a.keywords as unknown[]).map(String) : [],
    mood: str(a, 'mood'),
    durationSeconds: num(a, 'durationSeconds', 0),
  });
  const asset = await save(Buffer.from(JSON.stringify(seo, null, 2), 'utf8'), 'json', 'application/json', `${title} SEO`, skill);
  return {
    skill,
    ok: true,
    note: `${seo.titles.length} title, ${seo.tags.length} tag, ${seo.hashtags.length} hashtag, may description at chapters.`,
    assets: [asset],
    data: seo,
    download: { name: `${slug(title)}-seo.json`, mime: 'application/json', data: Buffer.from(JSON.stringify(seo, null, 2), 'utf8') },
  };
}

/** One entry per skill: how to describe it and how to run it for free. */
export const CONNECTORS: Record<
  string,
  { label: string; free: string; run: (a: Args) => Promise<ConnectorResult> }
> = {
  image_assets: {
    label: 'Cloudinary',
    free: 'Local asset store (assets/)',
    run: async a => {
      const title = str(a, 'title') || 'Asset';
      const ref = str(a, 'source') || str(a, 'url') || str(a, 'prompt');
      const file = await toImageFile(ref, title);
      const ext = (path.extname(file).slice(1) || 'png').toLowerCase();
      const mime = ext === 'mp4' ? 'video/mp4' : ext === 'json' ? 'application/json' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      const asset = await save(fs.readFileSync(file), ext, mime, title, 'image_assets');
      return { skill: 'image_assets', ok: true, note: 'Naka-save sa local asset store.', assets: [asset] };
    },
  },
  media_edit: {
    label: 'Picsart Media Studio',
    free: 'ffmpeg color grade',
    run: async a => {
      const file = await toVideoFile(str(a, 'source'), str(a, 'title') || 'Edited');
      const preset = (str(a, 'preset') || str(a, 'grade') || 'cinematic') as GradePreset;
      const out = await colorGrade(file, preset);
      const asset = await save(out.data, out.ext, out.mime, `${str(a, 'title') || 'Edited'} (${preset})`, 'media_edit');
      return { skill: 'media_edit', ok: true, note: `Grade: ${preset}.`, assets: [asset], download: { name: asset.name, mime: asset.mime, data: out.data } };
    },
  },
  poster_design: {
    label: 'Orshot',
    free: 'ffmpeg poster render',
    run: async a => {
      const title = str(a, 'title') || 'Bagong Pelikula';
      const bg = str(a, 'background') || str(a, 'prompt');
      let background: string | undefined;
      if (bg) {
        try {
          background = await toImageFile(bg, title);
        } catch {
          background = undefined; // fall back to a clean card, never fail the poster
        }
      }
      const out = await poster(title, { subtitle: str(a, 'subtitle'), background });
      const asset = await save(out.data, out.ext, out.mime, `${title} poster`, 'poster_design');
      return { skill: 'poster_design', ok: true, note: 'Poster na-render locally.', assets: [asset], download: { name: asset.name, mime: asset.mime, data: out.data } };
    },
  },
  video_edit: {
    label: 'Descript',
    free: 'ffmpeg trim',
    run: async a => {
      const file = await toVideoFile(str(a, 'source'), str(a, 'title') || 'Edit');
      const out = await trimVideo(file, num(a, 'start', 0), num(a, 'duration', 0) || undefined);
      const asset = await save(out.data, out.ext, out.mime, `${str(a, 'title') || 'Edit'} (trim)`, 'video_edit');
      return { skill: 'video_edit', ok: true, note: 'Na-trim locally.', assets: [asset], download: { name: asset.name, mime: asset.mime, data: out.data } };
    },
  },
  short_clips: { label: 'OpusClip', free: 'ffmpeg cut + 9:16', run: shortClips },
  auto_producer: { label: 'AI Producer by OpusClip', free: 'ffmpeg produced short', run: autoProducer },
  motion_video: {
    label: 'HyperFrames by HeyGen',
    free: 'ffmpeg ken-burns from stills',
    run: async a => {
      const list = Array.isArray(a.images) ? (a.images as unknown[]).map(String) : [];
      if (!list.length) throw new Error('Kailangan ng images (listahan ng asset name o URL).');
      const files: string[] = [];
      for (const ref of list) files.push(await toImageFile(ref, str(a, 'title') || 'Motion video'));
      const out = await imageToVideo(files, { secondsPerImage: num(a, 'secondsPerImage', 3) });
      const asset = await save(out.data, out.ext, out.mime, str(a, 'title') || 'Motion video', 'motion_video');
      return { skill: 'motion_video', ok: true, note: `${files.length} still na pinagalaw.`, assets: [asset], download: { name: asset.name, mime: asset.mime, data: out.data } };
    },
  },
  screen_demo: {
    label: 'Tella',
    free: 'ffmpeg lower-third caption',
    run: async a => {
      const file = await toVideoFile(str(a, 'source'), str(a, 'title') || 'Demo');
      const out = await addText(file, str(a, 'text') || str(a, 'title') || 'Demo', { placement: 'bottom' });
      const asset = await save(out.data, out.ext, out.mime, `${str(a, 'title') || 'Demo'} (captioned)`, 'screen_demo');
      return { skill: 'screen_demo', ok: true, note: 'Naka-burn ang caption.', assets: [asset], download: { name: asset.name, mime: asset.mime, data: out.data } };
    },
  },
  growth_seo: { label: 'vidIQ', free: 'local SEO builder', run: a => seoPack(a, 'growth_seo') },
  audience_research: { label: 'Tracy AI Interviewer', free: 'local SEO builder', run: a => seoPack(a, 'audience_research') },
  cloud_storage: {
    label: 'Google Drive',
    free: 'Google Drive API v3 (free) o local ZIP',
    run: async a => {
      const names = Array.isArray(a.names) ? (a.names as unknown[]).map(String) : undefined;
      const chosen = names?.length ? names : listAssets().map(x => x.name);

      // Real upload when Drive is set up; otherwise hand back a local ZIP so the
      // skill still produces something useful with no credentials.
      if (driveConfigured() && readTokens().refresh_token) {
        const uploaded: { name: string; id: string; link?: string }[] = [];
        for (const name of chosen) {
          const full = assetPath(name);
          if (!full) continue;
          const ext = path.extname(full).slice(1).toLowerCase();
          const mime = ext === 'mp4' ? 'video/mp4' : ext === 'png' ? 'image/png' : ext === 'json' ? 'application/json' : 'application/octet-stream';
          const file = await uploadFile(name, mime, fs.readFileSync(full));
          uploaded.push({ name: file.name, id: file.id, link: file.webViewLink });
        }
        return {
          skill: 'cloud_storage',
          ok: true,
          note: `${uploaded.length} file na-upload sa Google Drive.`,
          assets: [],
          data: { uploaded },
        };
      }

      const data = bundleAssets(names);
      return {
        skill: 'cloud_storage',
        ok: true,
        note: 'ZIP ng mga asset, nakaimbak locally. (I-set up ang Google Drive para sa totoong upload.)',
        assets: [],
        download: { name: 'direk-assets.zip', mime: 'application/zip', data },
      };
    },
  },
  drive_list: {
    label: 'Google Drive (list)',
    free: 'Google Drive API v3',
    run: async () => {
      if (!driveConfigured() || !readTokens().refresh_token) {
        return { skill: 'drive_list', ok: false, note: 'Hindi pa naka-set up ang Google Drive.', assets: [] };
      }
      const files = await listDriveFiles();
      return { skill: 'drive_list', ok: true, note: `${files.length} file sa Drive.`, assets: [], data: { files } };
    },
  },
  delete_asset: {
    label: 'Cloudinary/Drive delete',
    free: 'local asset delete',
    run: async a => {
      const name = str(a, 'name');
      const ok = name ? deleteAsset(name) : false;
      return { skill: 'delete_asset', ok, note: ok ? `Nabura ang '${name}'.` : `Hindi mahanap ang '${name}'.`, assets: [] };
    },
  },
  publish_post: { label: 'OpusClip/vidIQ/Tella', free: 'local publish bundle', run: publishPost },
};

/** Skills that only exist as a free local job, so the UI can show them. */
export function connectorCatalog(): { skill: string; was: string; free: string }[] {
  return Object.entries(CONNECTORS).map(([skill, c]) => ({ skill, was: c.label, free: c.free }));
}

/** Run one connector by skill name. */
export async function runConnector(skill: string, args: Args = {}): Promise<ConnectorResult> {
  const connector = CONNECTORS[skill];
  if (!connector) {
    return { skill, ok: false, note: `Walang connector na '${skill}'.`, assets: [] };
  }
  try {
    return await connector.run(args);
  } catch (error: any) {
    return { skill, ok: false, note: error?.message || 'Nabigo ang connector.', assets: [] };
  }
}

/** Everything the local store holds, for the UI. */
export function allAssets(): AssetMeta[] {
  return listAssets();
}

/** Join several saved videos into one, for a quick assembly. */
export async function joinAssets(names: string[], title: string): Promise<ConnectorResult> {
  const files: string[] = [];
  for (const name of names) {
    const full = assetPath(name);
    if (full) files.push(full);
  }
  const out = await concatVideos(files);
  const asset = await save(out.data, out.ext, out.mime, title || 'Assembly', 'auto_producer');
  return { skill: 'auto_producer', ok: true, note: `${files.length} clip ang pinagsama.`, assets: [asset], download: { name: asset.name, mime: asset.mime, data: out.data } };
}
