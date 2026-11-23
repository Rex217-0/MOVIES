/**
 * Seasonal 8-genre harvest.
 *
 * One sweep fills eight genre datasets — ten approved images each, eighty in
 * total — so a LoRA per genre can be trained from a single run. Every image goes
 * through the Bodegero first: what passes lands in the run's dataset, what fails
 * is quarantined with its reason. Nothing is silently dropped.
 *
 * The schedule is a plain JSON file the operator can edit by hand or over HTTP,
 * and a minute ticker that reads it. Keeping the "is it due?" decision a pure
 * function means the clock can be tested without waiting for one.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { harvestImagesForLora, type HarvestSource } from './loraHarvester.ts';
import { inspectImageWithBodegero, quarantineRejectedImage } from './bodegeroChecker.ts';

export const DEFAULT_GENRES = [
  'horror',
  'comedy',
  'action',
  'scifi',
  'love_story',
  'thriller',
  'anime',
  'cartoons',
] as const;

export const DEFAULT_PER_GENRE = 10;

/** How many extra pulls a genre may attempt before giving up on its target. */
const MAX_ROUNDS_PER_GENRE = 6;

/**
 * Search words per genre. The harvest query must be short to survive the query
 * ladder, and `love_story` is a filename token, not something a photo site
 * indexes, so each genre maps to words a real search actually answers.
 */
const GENRE_QUERY: Record<string, string> = {
  horror: 'dark horror cinematic',
  comedy: 'funny comedy bright',
  action: 'action explosion cinematic',
  scifi: 'science fiction futuristic',
  love_story: 'romantic couple sunset',
  thriller: 'thriller suspense dark',
  anime: 'anime illustration colorful',
  cartoons: 'cartoon illustration colorful',
};

export function queryForGenre(genre: string, theme: string): string {
  const base = GENRE_QUERY[genre] || genre.replace(/_/g, ' ');
  return theme ? `${base} ${theme}` : base;
}

export interface ScheduleConfig {
  enabled: boolean;
  /** Local clock hour, 0-23. */
  hour: number;
  minute: number;
  /** 0 = Sunday. null means "any day". */
  dayOfWeek: number | null;
  /** 1-31. null means "any". */
  dayOfMonth: number | null;
  /** 1-12. null means "any". */
  month: number | null;
  theme: string;
  genres: string[];
  perGenreCount: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  enabled: false,
  hour: 2,
  minute: 0,
  dayOfWeek: null,
  dayOfMonth: null,
  month: null,
  theme: '',
  genres: [...DEFAULT_GENRES],
  perGenreCount: DEFAULT_PER_GENRE,
};

export function schedulePath(cwd = process.cwd()): string {
  return path.join(cwd, 'harvest_schedule.json');
}

/** Read the saved schedule, falling back to the defaults when it is absent or broken. */
export function loadSchedule(cwd = process.cwd()): ScheduleConfig {
  const file = schedulePath(cwd);
  if (!fs.existsSync(file)) return { ...DEFAULT_SCHEDULE, genres: [...DEFAULT_GENRES] };
  try {
    return normalizeSchedule(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_SCHEDULE, genres: [...DEFAULT_GENRES] };
  }
}

export function saveSchedule(config: ScheduleConfig, cwd = process.cwd()): ScheduleConfig {
  const normalized = normalizeSchedule(config);
  fs.writeFileSync(schedulePath(cwd), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

/**
 * Coerce anything into a valid schedule. A hand-edited JSON file is a normal
 * way to configure this, so a typo must not crash the ticker: out-of-range
 * numbers fall back to the default instead of throwing.
 */
export function normalizeSchedule(raw: any): ScheduleConfig {
  const num = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) return fallback;
    return Math.trunc(n);
  };
  const optional = (value: unknown, min: number, max: number): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return Math.trunc(n);
  };

  const genres = Array.isArray(raw?.genres)
    ? raw.genres
        .filter((g: unknown) => typeof g === 'string' && /^[a-z0-9_]{2,24}$/.test(g))
        .slice(0, 12)
    : [...DEFAULT_GENRES];

  return {
    enabled: Boolean(raw?.enabled),
    hour: num(raw?.hour, 0, 23, DEFAULT_SCHEDULE.hour),
    minute: num(raw?.minute, 0, 59, DEFAULT_SCHEDULE.minute),
    dayOfWeek: optional(raw?.dayOfWeek, 0, 6),
    dayOfMonth: optional(raw?.dayOfMonth, 1, 31),
    month: optional(raw?.month, 1, 12),
    theme: typeof raw?.theme === 'string' ? raw.theme.trim().slice(0, 120) : '',
    genres: genres.length ? genres : [...DEFAULT_GENRES],
    perGenreCount: num(raw?.perGenreCount, 1, 40, DEFAULT_PER_GENRE),
  };
}

/**
 * Is the schedule due at `now`? All the set fields must match — an unset field
 * is a wildcard. Returns false when disabled, so a saved-but-off schedule never
 * fires.
 */
export function isScheduleDue(config: ScheduleConfig, now: Date): boolean {
  if (!config.enabled) return false;
  if (now.getHours() !== config.hour || now.getMinutes() !== config.minute) return false;
  if (config.dayOfWeek !== null && now.getDay() !== config.dayOfWeek) return false;
  if (config.dayOfMonth !== null && now.getDate() !== config.dayOfMonth) return false;
  if (config.month !== null && now.getMonth() + 1 !== config.month) return false;
  return true;
}

/** A key that is identical for every tick inside the same due minute. */
export function dueKey(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export interface SeasonalOptions {
  /** Folder name under lora_runs/, lora_staging/ and lora_rejected/. */
  batchSlug: string;
  theme?: string;
  genres?: string[];
  perGenreCount?: number;
  triggerToken?: string;
  /** Root that holds lora_runs, lora_staging and lora_rejected. */
  root?: string;
  /** Test hook: point the harvester at a local server. */
  endpoints?: Partial<Record<HarvestSource, string>>;
}

export interface GenreResult {
  genre: string;
  target: number;
  approved: number;
  rejected: number;
  failures: number;
  /** Reasons of the quarantined images, in order. */
  rejectReasons: string[];
  complete: boolean;
}

export interface SeasonalResult {
  ok: boolean;
  batchSlug: string;
  theme: string;
  datasetDir: string;
  stagingDir: string;
  rejectedDir: string;
  requested: number;
  approved: number;
  rejected: number;
  perGenre: GenreResult[];
  note: string;
}

/** Keep a batch slug safe as a folder name. */
export function slugifyBatch(raw: string): string {
  // The slug doubles as the LoRA trigger token, which only accepts lowercase
  // letters, digits and underscores, and must start with a letter. Normalising
  // to that shape here is what keeps a date-derived default (which contains
  // hyphens) from failing validation on every single run.
  const cleaned = (raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const stem = cleaned || `batch_${new Date().toISOString().slice(0, 10).replace(/-/g, '_')}`;
  // A token may not begin with a digit or underscore, so anchor it to a letter,
  // and it must be at least three characters long.
  const anchored = /^[a-z]/.test(stem) ? stem : `b_${stem}`;
  return anchored.length >= 3 ? anchored.slice(0, 40) : `${anchored}_batch`.slice(0, 40);
}

function nextIndexIn(dir: string, prefix: string): number {
  let highest = 0;
  if (!fs.existsSync(dir)) return 1;
  for (const entry of fs.readdirSync(dir)) {
    const match = new RegExp(`^${prefix}_(\\d+)\\.png$`).exec(entry);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/**
 * Run one seasonal sweep. Each genre is filled independently, so one genre that
 * finds nothing does not stop the other seven.
 */
export async function runSeasonalHarvest(options: SeasonalOptions): Promise<SeasonalResult> {
  const batchSlug = slugifyBatch(options.batchSlug);
  const theme = (options.theme || '').trim();
  const triggerToken = (options.triggerToken || batchSlug).trim();
  const genres = (options.genres && options.genres.length ? options.genres : [...DEFAULT_GENRES]).slice(0, 12);
  const perGenre = Math.min(Math.max(Number(options.perGenreCount) || DEFAULT_PER_GENRE, 1), 40);

  const root = options.root || process.cwd();
  const datasetDir = path.join(root, 'lora_runs', batchSlug, 'dataset');
  const stagingDir = path.join(root, 'lora_staging', batchSlug);
  const rejectedRoot = path.join(root, 'lora_rejected');

  await fsp.mkdir(datasetDir, { recursive: true });
  await fsp.mkdir(stagingDir, { recursive: true });

  const perGenreResults: GenreResult[] = [];

  for (const genre of genres) {
    const result: GenreResult = {
      genre,
      target: perGenre,
      approved: 0,
      rejected: 0,
      failures: 0,
      rejectReasons: [],
      complete: false,
    };

    for (let round = 0; round < MAX_ROUNDS_PER_GENRE && result.approved < perGenre; round += 1) {
      const stillNeeded = perGenre - result.approved;
      const genreStaging = path.join(stagingDir, genre);

      let harvested;
      try {
        harvested = await harvestImagesForLora({
          query: queryForGenre(genre, theme),
          triggerToken,
          count: stillNeeded,
          targetDir: genreStaging,
          endpoints: options.endpoints,
        });
      } catch (error: any) {
        // A harvest that cannot even search is not an image failure; stop this genre.
        result.failures += 1;
        result.rejectReasons.push(`HARVEST_ERROR: ${error?.message || String(error)}`);
        break;
      }

      result.failures += harvested.failures.length;
      if (harvested.samples.length === 0) break;

      let prefix = `${batchSlug}_${genre}`;
      for (const sample of harvested.samples) {
        if (result.approved >= perGenre) break;
        const staged = path.join(genreStaging, sample.file);

        const decision = await inspectImageWithBodegero(staged, triggerToken, genre, theme);
        if (!decision.passed) {
          await quarantineRejectedImage(staged, batchSlug, decision.reason, rejectedRoot);
          result.rejected += 1;
          result.rejectReasons.push(decision.reason);
          continue;
        }

        const index = nextIndexIn(datasetDir, prefix);
        const stem = `${prefix}_${String(index).padStart(3, '0')}`;
        const dest = path.join(datasetDir, `${stem}.png`);
        try {
          await fsp.rename(staged, dest).catch(async () => {
            await fsp.copyFile(staged, dest);
            await fsp.unlink(staged).catch(() => {});
          });
          // Caption must sit next to the image as `<stem>.txt`, not
          // `<stem>.png.txt`: the trainer looks up the image's stem, so the
          // doubled extension would leave every sample uncaptioned.
          await fsp.writeFile(path.join(datasetDir, `${stem}.txt`), `${decision.cleanCaption}\n`, 'utf8');
          // The harvester's own caption is superseded by the Bodegero's.
          await fsp.unlink(path.join(genreStaging, sample.captionFile)).catch(() => {});
          result.approved += 1;
        } catch (error: any) {
          result.failures += 1;
          result.rejectReasons.push(`MOVE_ERROR: ${error?.message || String(error)}`);
        }
      }
    }

    result.complete = result.approved >= perGenre;
    perGenreResults.push(result);
  }

  const approved = perGenreResults.reduce((sum, g) => sum + g.approved, 0);
  const rejected = perGenreResults.reduce((sum, g) => sum + g.rejected, 0);
  const requested = perGenre * genres.length;
  const short = perGenreResults.filter(g => !g.complete).map(g => g.genre);

  const note = approved === 0
    ? `Walang na-approve sa ${genres.length} genre. ${rejected} ang na-reject, ${perGenreResults.reduce((s, g) => s + g.failures, 0)} ang bigo.`
    : short.length === 0
      ? `Kumpleto: ${approved}/${requested} aprubadong PNG sa ${genres.length} genre (${rejected} na-reject).`
      : `${approved}/${requested} aprubadong PNG. Kulang ang: ${short.join(', ')} (${rejected} na-reject).`;

  return {
    ok: approved > 0,
    batchSlug,
    theme,
    datasetDir,
    stagingDir,
    rejectedDir: path.join(rejectedRoot, batchSlug),
    requested,
    approved,
    rejected,
    perGenre: perGenreResults,
    note,
  };
}

/**
 * Start the minute ticker. It re-reads the schedule file every tick, so an edit
 * made through the API (or by hand) takes effect without a restart. Returns a
 * stop function.
 */
export function startScheduleTicker(
  onDue: (config: ScheduleConfig) => unknown,
  opts: { cwd?: string; intervalMs?: number; now?: () => Date; log?: (msg: string) => void } = {},
): () => void {
  const cwd = opts.cwd || process.cwd();
  const intervalMs = opts.intervalMs ?? 60_000;
  const now = opts.now || (() => new Date());
  const log = opts.log || ((msg: string) => console.log(msg));

  let lastFired = '';
  let running = false;

  const tick = async () => {
    // A sweep takes minutes; never start a second one on top of it.
    if (running) return;
    const config = loadSchedule(cwd);
    const stamp = now();
    if (!isScheduleDue(config, stamp)) return;
    const key = dueKey(stamp);
    if (key === lastFired) return;
    lastFired = key;
    running = true;
    try {
      log(`[SCHEDULE] Nagsisimula ang seasonal harvest (theme: ${config.theme || 'wala'})`);
      await onDue(config);
    } catch (error: any) {
      log(`[SCHEDULE] Bigo: ${error?.message || String(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
