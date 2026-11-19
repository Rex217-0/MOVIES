/**
 * Real stock footage, so a clip can contain actual people, animals, places,
 * weather and skies instead of only generated pixels.
 *
 * Three providers, asked in order: Pexels, Pixabay, then Wikimedia Commons.
 * Pexels and Pixabay give away a free API key and serve real footage shot on
 * real cameras; Commons needs no key at all, so real footage works on a bare
 * install, and it is asked last because its catalogue is smaller.
 *
 * This engine never invents a clip. If no key is configured, if the search finds
 * nothing, or if the download is not a video, it throws and the caller moves on
 * to the next engine. A still image is never returned here.
 */

import { execFile } from 'node:child_process';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpegPath } from './render.ts';

/** Where a clip came from, so the UI can credit the source honestly. */
export interface StockClip {
  data: Buffer;
  /** Which service the footage came from. */
  provider: 'pexels' | 'pixabay' | 'commons';
  /** The page the footage came from, for attribution. */
  pageUrl: string;
  /** Who shot it. */
  author: string;
  /** Provider video id, for logs. */
  id: number;
  /** The licence the footage is under, when the provider states it. */
  licence?: string;
}

const PEXELS_BASE = 'https://api.pexels.com/videos/search';
const PIXABAY_BASE = 'https://pixabay.com/api/videos/';

/**
 * Overridable so a deployment can point at a proxy, and so the tests can serve a
 * local stand-in instead of the real service. Same convention as POLLINATIONS_URL.
 */
export function pexelsBase(): string {
  return (process.env.PEXELS_API_URL || PEXELS_BASE).trim();
}

export function pixabayBase(): string {
  return (process.env.PIXABAY_API_URL || PIXABAY_BASE).trim();
}

/** A clip has to be real video. Anything under this is a truncated download. */
const MIN_CLIP_BYTES = 20_000;

/**
 * Read at call time, not import time: a module-level constant froze the value
 * before a caller (or a test) could set it, so the budget silently ignored.
 */
function downloadTimeoutMs(): number {
  return Number(process.env.STOCK_DOWNLOAD_TIMEOUT_MS) || 30_000;
}

/**
 * A stock search is a fan-out - queries x hits x candidate URLs - so an
 * unbounded one can run for hours against a throttled provider. Cap the whole
 * search and let the caller fall back to the free engine instead.
 */
function stockSearchBudgetMs(): number {
  // 45s: a real Commons hit lands in about a second, so anything slower is a
  // throttled provider. Waiting longer only delays the free-engine fallback.
  return Number(process.env.STOCK_SEARCH_BUDGET_MS) || 45_000;
}

/**
 * A scene is seconds long, so there is no reason to pull a 60 MB archival
 * master. Wikimedia holds plenty of those, and their originals are exactly what
 * its CDN throttles, so anything past this cap is skipped in favour of the next
 * hit's transcoded derivative.
 */
const MAX_CLIP_BYTES = 40_000_000;

export function pexelsKey(): string {
  return (process.env.PEXELS_API_KEY || '').trim();
}

export function pixabayKey(): string {
  return (process.env.PIXABAY_API_KEY || '').trim();
}

/**
 * Wikimedia's API policy asks for a descriptive User-Agent; requests without one
 * are rate-limited or refused.
 */
export function commonsUserAgent(): string {
  return (process.env.WIKIMEDIA_USER_AGENT || 'MovieCreator/1.0 (open-source film tool)').trim();
}

export function commonsApi(): string {
  return (process.env.WIKIMEDIA_API_URL || 'https://commons.wikimedia.org/w/api.php').trim();
}

/** Commons needs no key, so real footage is available on a bare install. */
export function commonsEnabled(): boolean {
  return process.env.COMMONS_DISABLE !== '1';
}

/** True when at least one stock provider can be searched. */
export function stockConfigured(): boolean {
  return Boolean(pexelsKey() || pixabayKey() || commonsEnabled());
}

/**
 * Words that describe how a shot is filmed rather than what is in it. A stock
 * catalogue indexes subjects, so these only dilute the search.
 */
const CAMERA_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'with', 'and', 'or', 'to', 'for',
  'cinematic', 'film', 'filmed', 'shot', 'scene', 'footage', 'clip', 'video',
  'camera', 'slow', 'fast', 'push', 'pull', 'pan', 'zoom', 'close', 'wide',
  'angle', 'light', 'lighting', 'natural', 'style', 'quality', 'high', 'low',
  '4k', '8k', 'hd', 'fps', 'bokeh', 'depth', 'field', 'view', 'motion',
  'dramatic', 'beautiful', 'stunning', 'golden', 'hour', 'soft', 'warm',
]);

/**
 * Reduce a cinematic prompt to the few words a stock search understands.
 * Stock APIs match on subject nouns, not on camera direction: "slow camera push
 * in, 35mm" returns nothing while "fisherman boat sea" returns real footage.
 */
export function stockQuery(prompt: string, maxWords = 6): string {
  const words = (prompt || '')
    .toLowerCase()
    // Split camera jargon that is glued to a number, e.g. "35mm" or "24fps".
    .replace(/\b\d+\s*(mm|fps|k)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !CAMERA_WORDS.has(w));
  return [...new Set(words)].slice(0, maxWords).join(' ');
}

/**
 * Progressively looser queries, because a stock search that fails on the full
 * phrase often succeeds on its first few words. Without this a prompt like
 * "ocean surface waves golden hour" returns nothing while "ocean waves" finds
 * real footage. Duplicates are dropped so the same search is never run twice.
 */
export function stockQueries(prompt: string): string[] {
  const full = stockQuery(prompt);
  if (!full) return [];
  const words = full.split(' ');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [full, words.slice(0, 3).join(' '), words.slice(0, 2).join(' ')]) {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

interface PexelsVideoFile {
  id: number;
  quality: string;
  file_type: string;
  width: number;
  height: number;
  link: string;
}

interface PexelsVideo {
  id: number;
  url: string;
  user: { name: string };
  video_files: PexelsVideoFile[];
}

/**
 * Pick the file closest to 1280px wide. The largest option can be hundreds of
 * megabytes, which is wasteful for a short scene, and the smallest is often
 * 360p and visibly soft on a phone.
 */
export function pickPexelsFile(files: PexelsVideoFile[], targetWidth = 1280): PexelsVideoFile | null {
  const mp4 = files.filter((f) => f.file_type === 'video/mp4' && f.link);
  if (!mp4.length) return null;
  return mp4.reduce((best, f) =>
    Math.abs(f.width - targetWidth) < Math.abs(best.width - targetWidth) ? f : best,
  );
}

async function searchPexels(query: string, minSeconds: number): Promise<StockClip | null> {
  const key = pexelsKey();
  if (!key) return null;

  const params = new URLSearchParams({
    query,
    per_page: '15',
    orientation: 'landscape',
    size: 'medium',
  });
  const res = await fetch(`${pexelsBase()}?${params}`, {
    headers: { Authorization: key },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Pexels search HTTP ${res.status}`);
  }
  const body = (await res.json()) as { videos?: PexelsVideo[] };
  const videos = body.videos ?? [];

  for (const video of videos) {
    const file = pickPexelsFile(video.video_files ?? []);
    if (!file) continue;
    try {
      const clip = await download(file.link);
      if (clip.length < MIN_CLIP_BYTES) continue;
      return {
        data: clip,
        provider: 'pexels',
        pageUrl: video.url,
        author: video.user?.name ?? 'Pexels contributor',
        id: video.id,
      };
    } catch {
      // A dead CDN link is not a reason to give up on the whole search.
      continue;
    }
  }
  return null;
}

interface PixabayHit {
  id: number;
  pageURL: string;
  user: string;
  videos: Record<string, { url: string; width: number; height: number }>;
}

interface CommonsHit {
  pageid: number;
  title: string;
  videoinfo?: Array<{
    url: string;
    mime?: string;
    size?: number;
    width?: number;
    height?: number;
    duration?: number;
    derivatives?: Array<{ src?: string; type?: string; width?: number; height?: number; transcodekey?: string }>;
    extmetadata?: Record<string, { value?: string }>;
  }>;
}

/** Strip the HTML Wikimedia returns for Artist, so the credit is plain text. */
function plainText(html: string | undefined): string {
  return (html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Wikimedia Commons needs no key and holds real, openly licensed footage, which
 * makes it the only real-footage source that works out of the box. It serves
 * Ogg/WebM rather than MP4, so the caller transcodes before delivery.
 */
async function searchCommons(
  query: string,
  minSeconds: number,
  deadline: number,
): Promise<StockClip | null> {
  const search = new URLSearchParams({
    action: 'query',
    format: 'json',
    list: 'search',
    srsearch: `filetype:video ${query}`,
    srnamespace: '6',
    srlimit: '15',
  });
  const listing = (await commonsApiJson(`${commonsApi()}?${search}`, 'search', deadline)) as {
    query?: { search?: Array<{ title: string }> };
  };
  const titles = (listing.query?.search ?? []).map((r) => r.title);
  if (!titles.length) return null;

  // The second call carries the URL, duration, licence and derivatives.
  const info = new URLSearchParams({
    action: 'query',
    format: 'json',
    titles: titles.join('|'),
    // videoinfo, not imageinfo: only videoinfo returns the transcoded
    // derivatives, and those are what stay under Wikimedia's rate limit.
    prop: 'videoinfo',
    viprop: 'derivatives|url|size|extmetadata',
  });
  const pages = (await commonsApiJson(`${commonsApi()}?${info}`, 'videoinfo', deadline)) as {
    query?: { pages?: Record<string, CommonsHit> };
  };

  const hits = Object.values(pages.query?.pages ?? {});
  for (const hit of hits) {
    if (Date.now() > deadline) return null;
    const ii = hit.videoinfo?.[0];
    if (!ii?.url) continue;
    if (ii.duration !== undefined && ii.duration < minSeconds) continue;
    if ((ii.size ?? 0) < MIN_CLIP_BYTES) continue;

    // Prefer a transcoded derivative: the original can be 60 MB, and Wikimedia
    // rate-limits (HTTP 429) large originals far more aggressively than its own
    // transcodes. 480p is the sane middle - 360p is visibly soft, 720p is heavy.
    const derivatives = (ii.derivatives ?? [])
      .filter((d) => d.src && (d.type || '').startsWith('video/'))
      .sort((a, b) => Math.abs((a.width ?? 0) - 854) - Math.abs((b.width ?? 0) - 854));

    // Fall back to the original only when it is small enough to be worth the
    // bandwidth; a 60 MB master is skipped rather than downloaded.
    const candidates = [
      ...derivatives.map((d) => d.src!),
      ...((ii.size ?? 0) <= MAX_CLIP_BYTES ? [ii.url] : []),
    ];
    if (!candidates.length) continue;

    for (const url of candidates) {
      if (Date.now() > deadline) return null;
      try {
        const data = await downloadCommons(url, deadline);
        if (!data || data.length < MIN_CLIP_BYTES) continue;
        if (data.length > MAX_CLIP_BYTES) continue;
        const meta = ii.extmetadata ?? {};
        return {
          data,
          provider: 'commons',
          pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(hit.title)}`,
          author: plainText(meta.Artist?.value) || 'Wikimedia Commons contributor',
          id: hit.pageid,
          licence: plainText(meta.LicenseShortName?.value) || 'tingnan ang page',
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Download over HTTP/2.
 *
 * Wikimedia's CDN answers HTTP/1.1 requests from a datacentre IP with 429 while
 * serving the same URL happily over HTTP/2, and `fetch` only speaks HTTP/1.1.
 * Using node:http2 directly is what makes Commons downloads work at all.
 */
function http2Download(
  url: string,
  headers: Record<string, string>,
  deadline?: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = http2.connect(`${target.protocol}//${target.host}`);
    // destroy(), not close(): close() waits for open streams, so a stalled
    // stream kept the socket - and the whole process - alive after we gave up.
    const fail = (error: Error) => {
      client.destroy();
      reject(error);
    };
    client.on('error', fail);

    // Without a deadline a stream that stalls mid-body never emits 'end' or
    // 'error', so the download hangs until the process dies.
    // Never outlive the search: a flat per-attempt timeout let three retries
    // of one URL add up past the whole budget.
    const remaining = deadline === undefined
      ? downloadTimeoutMs()
      : Math.min(downloadTimeoutMs(), Math.max(deadline - Date.now(), 0));
    const timer = setTimeout(
      () => fail(new Error('HTTP/2 download timed out')),
      remaining,
    );
    const done = (error: Error | null, data?: Buffer) => {
      clearTimeout(timer);
      if (error) fail(error);
      else resolve(data!);
    };

    const req = client.request({
      ':method': 'GET',
      ':path': `${target.pathname}${target.search}`,
      'user-agent': headers['User-Agent'] || commonsUserAgent(),
      accept: '*/*',
    });
    req.on('error', fail);

    const chunks: Buffer[] = [];
    req.on('response', (responseHeaders) => {
      const status = Number(responseHeaders[':status']);
      if (status !== 200) {
        fail(new Error(`HTTP ${status}`));
      }
    });
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      client.destroy();
      done(null, Buffer.concat(chunks));
    });
    req.end();
  });
}

/**
 * Wikimedia answers a burst of downloads with HTTP 429. Backing off and asking
 * again is the documented behaviour, so retry twice before giving up on a URL.
 */
async function downloadCommons(url: string, deadline?: number): Promise<Buffer | null> {
  const isHttps = url.startsWith('https:');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (deadline !== undefined && Date.now() > deadline) return null;
    try {
      // HTTP/2 is required for the real CDN but only exists over TLS; a plain
      // http URL (a proxy or a test server) goes through fetch instead.
      const data = isHttps
        ? await http2Download(url, { 'User-Agent': commonsUserAgent() }, deadline)
        : await plainDownload(url, deadline);
      if (data.length) return data;
    } catch {
      // Fall through to the backoff; a failed attempt is not fatal yet.
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  return null;
}

/**
 * The Commons query API also throttles, so a single 429 must not lose a search.
 * Retrying with backoff is what the API etiquette asks for.
 */
async function commonsApiJson(
  url: string,
  label: string,
  deadline?: number,
): Promise<unknown> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (deadline !== undefined && Date.now() > deadline) break;
    const res = await fetch(url, {
      headers: { 'User-Agent': commonsUserAgent() },
      signal: AbortSignal.timeout(
        deadline === undefined
          ? 30_000
          : Math.min(30_000, Math.max(deadline - Date.now(), 1)),
      ),
    });
    if (res.ok) return res.json();
    lastStatus = res.status;
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`Wikimedia ${label} HTTP ${lastStatus}`);
}

async function plainDownload(url: string, deadline?: number): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': commonsUserAgent() },
    // Share the download deadline; a hardcoded 180s here let one stalled body
    // outlive the whole search budget.
    signal: AbortSignal.timeout(
      deadline === undefined
        ? downloadTimeoutMs()
        : Math.min(downloadTimeoutMs(), Math.max(deadline - Date.now(), 0)),
    ),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function searchPixabay(query: string): Promise<StockClip | null> {
  const key = pixabayKey();
  if (!key) return null;

  const params = new URLSearchParams({
    key,
    q: query,
    video_type: 'film',
    per_page: '15',
    safesearch: 'true',
  });
  const res = await fetch(`${pixabayBase()}?${params}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Pixabay search HTTP ${res.status}`);
  }
  const body = (await res.json()) as { hits?: PixabayHit[] };
  const hits = body.hits ?? [];

  for (const hit of hits) {
    // Pixabay names its renditions tiny/small/medium/large; medium is the sane
    // default and large is the fallback when medium is absent.
    const file = hit.videos?.medium ?? hit.videos?.large ?? hit.videos?.small;
    if (!file?.url) continue;
    try {
      const clip = await download(file.url);
      if (clip.length < MIN_CLIP_BYTES) continue;
      return {
        data: clip,
        provider: 'pixabay',
        pageUrl: hit.pageURL,
        author: hit.user ?? 'Pixabay contributor',
        id: hit.id,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Commons serves Ogg/WebM, and the app labels every render `video/mp4`. Rather
 * than mislabel the bytes, transcode anything that is not already H.264 MP4 into
 * one. Clips that are already MP4 are passed through untouched, so Pexels and
 * Pixabay cost nothing extra.
 */
export async function toMp4(data: Buffer): Promise<Buffer> {
  // An MP4 keeps its 'ftyp' box at offset 4; Ogg starts with 'OggS' and WebM with
  // the EBML magic 0x1A45DFA3.
  const isMp4 = data.length > 12 && data.subarray(4, 8).toString('latin1') === 'ftyp';
  if (isMp4) return data;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-'));
  const input = path.join(dir, 'in.bin');
  const output = path.join(dir, 'out.mp4');
  try {
    fs.writeFileSync(input, data);
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegPath(),
        [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-i', input,
          '-an',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          output,
        ],
        { timeout: 300_000 },
        (error, _stdout, stderr) => {
          if (error) reject(new Error(`ffmpeg transcode failed: ${stderr || error.message}`));
          else resolve();
        },
      );
    });
    const out = fs.readFileSync(output);
    if (out.length < MIN_CLIP_BYTES) {
      throw new Error(`Sobrang liit ng na-transcode na clip: ${out.length} bytes`);
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('video/')) {
    throw new Error(`Hindi video ang na-download (content-type: ${type || 'wala'})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < MIN_CLIP_BYTES) {
    throw new Error(`Sobrang liit ng clip: ${buf.length} bytes`);
  }
  return buf;
}

/**
 * Find real footage for a prompt. Tries Pexels, then Pixabay, then Commons, and
 * for each one retries with a looser query before moving on. Returns null when
 * no provider is configured; throws when a provider was asked and nothing
 * matched, so the caller can tell "no key" from "search found nothing".
 */
export async function fetchStockClip(prompt: string, minSeconds = 3): Promise<StockClip | null> {
  if (!stockConfigured()) return null;

  const queries = stockQueries(prompt);
  if (!queries.length) {
    throw new Error('Walang makuhang search term mula sa prompt.');
  }

  const errors: string[] = [];
  const budgetMs = stockSearchBudgetMs();
  const deadline = Date.now() + budgetMs;

  const providers: Array<{
    name: string;
    enabled: () => boolean;
    run: (query: string) => Promise<StockClip | null>;
  }> = [
    { name: 'Pexels', enabled: () => Boolean(pexelsKey()), run: (q) => searchPexels(q, minSeconds) },
    { name: 'Pixabay', enabled: () => Boolean(pixabayKey()), run: (q) => searchPixabay(q) },
    { name: 'Wikimedia Commons', enabled: commonsEnabled, run: (q) => searchCommons(q, minSeconds, deadline) },
  ];

  for (const provider of providers) {
    if (!provider.enabled()) continue;
    let lastError: unknown = null;
    for (const query of queries) {
      if (Date.now() > deadline) {
        errors.push(`${provider.name}: lumampas sa ${budgetMs / 1000}s na budget`);
        break;
      }
      try {
        const hit = await provider.run(query);
        if (hit) return hit;
      } catch (error) {
        lastError = error;
      }
    }
    errors.push(
      lastError
        ? `${provider.name}: ${(lastError as any)?.message || lastError}`
        : `${provider.name}: walang tugmang video para sa "${queries[0]}"`,
    );
  }

  throw new Error(errors.join('; '));
}
