/**
 * Season 1 — the multi-source free LoRA image harvester ("Kargador").
 *
 * Three mines, no API key on any of them:
 *   - Wallhaven  : 4K/HD sci-fi, anime, cartoons, horror, action, cinematic art
 *   - Openverse  : real photography — portraits, drama, love story, seasonal
 *   - Wikimedia  : documentary, places, public-domain reference material
 *
 * Everything it downloads is re-encoded to a genuine `.png` through ffmpeg, so a
 * training folder holds one predictable format even when the source was a WebP
 * from a CDN. Files are numbered after whatever is already in the folder, so a
 * starter sample is never overwritten.
 *
 * The Bodegero (QC gatekeeper) inspects these on the next season; this module
 * only reports what it actually saved, never what it hoped to save.
 */

import fs from 'node:fs';
import path from 'node:path';
import { toPng } from '../../direk/render.ts';
import { isValidTrigger } from '../../direk/lora.ts';

/** The three free mines, in the order the harvester tries them. */
export type HarvestSource = 'wallhaven' | 'openverse' | 'wikimedia';

export const HARVEST_SOURCES: HarvestSource[] = ['wallhaven', 'openverse', 'wikimedia'];

/** A real browser-ish UA: several of these APIs reject an empty or bot UA. */
const USER_AGENT =
  'MovieCreator/1.2 (+https://github.com/Rex217-0/MOVIES; LoRA dataset harvester)';

const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Minimum size a candidate must report before we bother downloading it. */
const MIN_WIDTH = 1000;
const MIN_HEIGHT = 720;

export interface HarvestCandidate {
  url: string;
  source: HarvestSource;
  width?: number;
  height?: number;
  /** The page the image was found on, kept for attribution. */
  page?: string;
}

export interface HarvestedSample {
  index: number;
  file: string;
  captionFile: string;
  source: HarvestSource;
  sourceUrl: string;
  width?: number;
  height?: number;
  bytes: number;
}

export interface HarvestFailure {
  source: HarvestSource;
  url: string;
  reason: string;
}

export interface HarvestResult {
  triggerToken: string;
  query: string;
  targetDir: string;
  requested: number;
  /** How many genuine PNGs were written. */
  saved: number;
  samples: HarvestedSample[];
  failures: HarvestFailure[];
  /** Sources that answered the search, even if nothing was kept. */
  sourcesAnswered: HarvestSource[];
  /** The query each mine actually matched, after the ladder shortened it. */
  usedQueries: Partial<Record<HarvestSource, string>>;
  /** Plain-language summary for the UI and the model. */
  note: string;
}

export interface HarvestOptions {
  query: string;
  triggerToken: string;
  count?: number;
  targetDir?: string;
  /** Overridable so tests can point at a local server instead of the internet. */
  endpoints?: Partial<Record<HarvestSource, string>>;
}

const DEFAULT_COUNT = 15;
const MAX_COUNT = 60;

function endpointFor(source: HarvestSource, override?: Partial<Record<HarvestSource, string>>): string {
  const custom = override?.[source];
  if (custom) return custom;
  switch (source) {
    case 'wallhaven':
      return 'https://wallhaven.cc/api/v1/search';
    case 'openverse':
      return 'https://api.openverse.org/v1/images/';
    case 'wikimedia':
      return 'https://commons.wikimedia.org/w/api.php';
  }
}

function buildSearchUrl(source: HarvestSource, base: string, query: string): string {
  const q = encodeURIComponent(query);
  switch (source) {
    case 'wallhaven':
      return `${base}?q=${q}&purity=100&atleast=1280x720&sorting=relevance`;
    case 'openverse':
      // 20 is the hard ceiling for an anonymous request; asking for more is a 401.
      return `${base}?q=${q}&page_size=20`;
    case 'wikimedia':
      return (
        `${base}?action=query&generator=search&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}` +
        `&gsrnamespace=6&gsrlimit=30&prop=imageinfo&iiprop=url|size&format=json&origin=*`
      );
  }
}

/**
 * A long query is the single biggest cause of an empty harvest: Wallhaven and
 * Wikimedia match all terms, so "cyberpunk neon portrait futuristic hologram
 * sci-fi" returns nothing while "cyberpunk neon portrait" returns 24. Try the
 * full query first, then drop trailing words until a mine answers.
 */
export function queryLadder(query: string): string[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const ladder: string[] = [];
  for (let n = words.length; n >= 1; n -= 1) ladder.push(words.slice(0, n).join(' '));
  return ladder;
}

/**
 * Wikimedia appends marketing query params to `imageinfo.url`. Left in place they
 * travel into the saved filename and confuse the extension check, so strip them.
 */
export function cleanImageUrl(raw: string): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_')) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/** Pull candidates out of each API's own response shape. */
export function parseCandidates(
  source: HarvestSource,
  payload: any,
  query: string,
): HarvestCandidate[] {
  const out: HarvestCandidate[] = [];

  if (source === 'wallhaven') {
    for (const item of payload?.data ?? []) {
      const url = cleanImageUrl(String(item?.path ?? ''));
      if (!url) continue;
      const width = Number(item?.dimension_x) || undefined;
      const height = Number(item?.dimension_y) || undefined;
      out.push({ url, source, width, height, page: item?.url });
    }
    return out;
  }

  if (source === 'openverse') {
    for (const item of payload?.results ?? []) {
      const url = cleanImageUrl(String(item?.url ?? ''));
      if (!url) continue;
      const width = Number(item?.width) || undefined;
      const height = Number(item?.height) || undefined;
      if (!(Number(width) >= MIN_WIDTH || Number(height) >= MIN_HEIGHT)) continue;
      out.push({ url, source, width, height, page: item?.foreign_landing_url });
    }
    return out;
  }

  // Wikimedia: pages is an object keyed by pageid, and order is not guaranteed.
  const pages = payload?.query?.pages ?? {};
  for (const page of Object.values<any>(pages)) {
    const info = page?.imageinfo?.[0];
    const url = cleanImageUrl(String(info?.url ?? ''));
    if (!url) continue;
    const width = Number(info?.width) || undefined;
    const height = Number(info?.height) || undefined;
    if (!(Number(width) >= MIN_WIDTH || Number(height) >= MIN_HEIGHT)) continue;
    out.push({ url, source, width, height, page: info?.descriptionurl });
  }
  return out;
}

/** The caption that trains alongside one image. */
export function buildHarvestCaption(triggerToken: string, query: string): string {
  return `${triggerToken}, ${query}, ultra high definition, 4k, realistic cinematic lighting`;
}

/** The next free `<trigger>_NNN` index, so existing samples are never clobbered. */
export function nextFreeIndex(dir: string, triggerToken: string): number {
  if (!fs.existsSync(dir)) return 1;
  const re = new RegExp(`^${triggerToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)\\.(png|txt)$`, 'i');
  let max = 0;
  for (const entry of fs.readdirSync(dir)) {
    const match = re.exec(entry);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

async function search(
  source: HarvestSource,
  query: string,
  endpoints?: Partial<Record<HarvestSource, string>>,
): Promise<{ candidates: HarvestCandidate[]; usedQuery: string }> {
  const base = endpointFor(source, endpoints);
  let lastError: Error | null = null;
  for (const attempt of queryLadder(query)) {
    try {
      const res = await fetch(buildSearchUrl(source, base, attempt), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`search ${source} returned ${res.status}`);
      const candidates = parseCandidates(source, await res.json(), attempt);
      if (candidates.length > 0) return { candidates, usedQuery: attempt };
    } catch (error: any) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { candidates: [], usedQuery: query };
}

/** Magic numbers for the formats these mines actually serve. */
export function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const gif = buffer.subarray(0, 3).toString('latin1') === 'GIF';
  const webp = buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP';
  return png || jpeg || gif || webp;
}

/**
 * Download one image. A CDN sometimes answers an expired link with a 200 and an
 * HTML error page, which would be saved as a broken sample, so the bytes must
 * actually look like an image before they are accepted.
 */
async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`download returned ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!looksLikeImage(buffer)) {
    const type = res.headers.get('content-type') || 'unknown type';
    throw new Error(`download was not an image (${type})`);
  }
  return buffer;
}

/**
 * Harvest up to `count` images across all three mines, writing real PNGs plus a
 * caption for each into `targetDir`. Round-robins the sources so one mine cannot
 * fill the whole set, and keeps going past individual failures.
 */
export async function harvestImagesForLora(options: HarvestOptions): Promise<HarvestResult> {
  const query = (options.query || '').trim();
  const triggerToken = (options.triggerToken || '').trim();
  if (!query) throw new Error('Kailangan ng query para sa paghahanap.');
  if (!isValidTrigger(triggerToken)) {
    throw new Error(
      `Invalid trigger token '${triggerToken}'. Use lowercase letters, digits and underscores (3-40 chars).`,
    );
  }

  const count = Math.min(Math.max(Number(options.count) || DEFAULT_COUNT, 1), MAX_COUNT);
  const targetDir =
    options.targetDir || path.join(process.cwd(), 'lora_runs', triggerToken, 'dataset');
  fs.mkdirSync(targetDir, { recursive: true });

  const scratchDir = fs.mkdtempSync(path.join(targetDir, '.harvest-'));
  const failures: HarvestFailure[] = [];
  const sourcesAnswered: HarvestSource[] = [];

  // Gather candidates from every mine first; a dead mine costs its own search only.
  const pools = new Map<HarvestSource, HarvestCandidate[]>();
  const usedQueries = new Map<HarvestSource, string>();
  await Promise.all(
    HARVEST_SOURCES.map(async source => {
      try {
        const { candidates, usedQuery } = await search(source, query, options.endpoints);
        pools.set(source, candidates);
        usedQueries.set(source, usedQuery);
        sourcesAnswered.push(source);
      } catch (error: any) {
        pools.set(source, []);
        failures.push({ source, url: '', reason: error?.message || String(error) });
      }
    }),
  );

  const samples: HarvestedSample[] = [];
  const seen = new Set<string>();
  let index = nextFreeIndex(targetDir, triggerToken);
  let round = 0;

  while (samples.length < count) {
    let progressed = false;
    for (const source of HARVEST_SOURCES) {
      if (samples.length >= count) break;
      const pool = pools.get(source) ?? [];
      const candidate = pool[round];
      if (!candidate) continue;
      progressed = true;
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);

      try {
        const raw = await download(candidate.url);
        const png = await toPng(raw);
        const stem = `${triggerToken}_${String(index).padStart(3, '0')}`;
        const file = path.join(targetDir, `${stem}.png`);
        const captionFile = path.join(targetDir, `${stem}.txt`);
        fs.writeFileSync(file, png);
        fs.writeFileSync(captionFile, buildHarvestCaption(triggerToken, query) + '\n');
        samples.push({
          index,
          file: path.basename(file),
          captionFile: path.basename(captionFile),
          source,
          sourceUrl: candidate.url,
          width: candidate.width,
          height: candidate.height,
          bytes: png.length,
        });
        index += 1;
      } catch (error: any) {
        failures.push({ source, url: candidate.url, reason: error?.message || String(error) });
      }
    }
    round += 1;
    const exhausted = HARVEST_SOURCES.every(s => (pools.get(s)?.length ?? 0) <= round);
    if (!progressed || exhausted) break;
  }

  fs.rmSync(scratchDir, { recursive: true, force: true });

  const note = samples.length > 0
    ? `Naka-save ang ${samples.length} PNG sa ${path.relative(process.cwd(), targetDir) || targetDir} (mula sa ${[...new Set(samples.map(s => s.source))].join(', ')}).`
    : failures.length > 0
      ? `Walang na-save. Sinubukan ang ${HARVEST_SOURCES.join(', ')}; ${failures.length} ang bigo.`
      : `Walang na-save: walang nahanap na larawan para sa "${query}" sa ${HARVEST_SOURCES.join(', ')}. Subukan ang mas simpleng query.`;

  return {
    triggerToken,
    query,
    targetDir,
    requested: count,
    saved: samples.length,
    samples,
    failures,
    sourcesAnswered,
    usedQueries: Object.fromEntries(usedQueries) as Partial<Record<HarvestSource, string>>,
    note,
  };
}
