/**
 * Kaggle Pilot bridge — the one place that talks to the external cloud worker.
 *
 * The Kaggle Notebook (Qwen 2.5 3B) is an EXTERNAL CLOUD WORKER. It does not
 * live in this repository or on this machine: it runs on Kaggle's GPU and is
 * reached over the internet through a Cloudflare tunnel. The tunnel's public URL
 * is given by `KAGGLE_PILOT_URL`, so the Pilot can move between sessions without
 * a code change.
 *
 * This module is server-only (it uses `fetch` and `process.env`) and must never
 * be imported by the browser bundle. When the worker is not configured or is not
 * answering, every call fails with an honest `PILOT_UNAVAILABLE` (HTTP 503)
 * error — the app never invents a script or a scene list.
 *
 * Expected Kaggle API (all JSON in, JSON out):
 *   GET  /health                       -> 200 when the worker is up
 *   POST /generate_script              { brief }   -> { script }   (or { text })
 *   POST /generate_character_bible     { script }  -> { bible }    (or { text })
 *   POST /breakdown_scenes             { script }  -> { scenes: [ ... ] }
 *
 * Configuration (environment variables):
 *   KAGGLE_PILOT_URL          Base URL of the tunnel (required), e.g.
 *                             https://xxxx-yyyy.trycloudflare.com
 *   KAGGLE_PILOT_SCRIPT_PATH  default /generate_script
 *   KAGGLE_PILOT_BIBLE_PATH   default /generate_character_bible
 *   KAGGLE_PILOT_SCENES_PATH  default /breakdown_scenes
 *   KAGGLE_PILOT_TOKEN        optional bearer token for the tunnel
 *   KAGGLE_PILOT_TIMEOUT_MS   per-call timeout, default 120000
 */

/** The honest error code every Pilot failure carries. */
export const PILOT_UNAVAILABLE = 'PILOT_UNAVAILABLE';

/** The model name reported in error bodies, for the UI and the logs. */
export const PILOT_MODEL = 'kaggle-pilot';

/** One scene from the Pilot's breakdown, before it is merged onto the plan. */
export interface PilotScene {
  heading: string;
  narration: string;
  visual: string;
  mood: string;
}

/**
 * Thrown whenever the Kaggle Pilot cannot be reached or answered badly. The
 * caller turns this into an honest HTTP 503 `PILOT_UNAVAILABLE` — it is never
 * swallowed into a fabricated script.
 */
export class PilotUnavailable extends Error {
  readonly code = PILOT_UNAVAILABLE;
  readonly model = PILOT_MODEL;
  readonly status = 503;
  readonly detail: string;

  constructor(detail: string) {
    super(`Walang Kaggle Pilot: ${detail}`);
    this.name = 'PilotUnavailable';
    this.detail = detail;
  }
}

/** The tunnel base URL, without a trailing slash. Empty when unset. */
export function pilotUrl(): string {
  return (process.env.KAGGLE_PILOT_URL || '').trim().replace(/\/+$/, '');
}

/** True when a tunnel URL has been configured. */
export function pilotConfigured(): boolean {
  return pilotUrl().length > 0;
}

function endpointPath(kind: 'script' | 'bible' | 'scenes'): string {
  const fromEnv = {
    script: process.env.KAGGLE_PILOT_SCRIPT_PATH,
    bible: process.env.KAGGLE_PILOT_BIBLE_PATH,
    scenes: process.env.KAGGLE_PILOT_SCENES_PATH,
  }[kind];
  const fallback = {
    script: '/generate_script',
    bible: '/generate_character_bible',
    scenes: '/breakdown_scenes',
  }[kind];
  const path = (fromEnv || fallback).trim();
  return path.startsWith('/') ? path : `/${path}`;
}

function pilotTimeoutMs(): number {
  const n = Number(process.env.KAGGLE_PILOT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 120000;
}

export interface PilotStatus {
  configured: boolean;
  reachable: boolean;
  url: string;
  detail: string;
}

/**
 * Probe the worker. A short timeout keeps this usable as a status badge: a dead
 * tunnel reports `reachable: false` instead of hanging the request.
 */
export async function pilotStatus(): Promise<PilotStatus> {
  const url = pilotUrl();
  if (!url) {
    return {
      configured: false,
      reachable: false,
      url: '',
      detail: 'Walang KAGGLE_PILOT_URL — hindi naka-set ang Cloudflare tunnel URL ng Kaggle Notebook.',
    };
  }
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return { configured: true, reachable: true, url, detail: 'Online ang Kaggle Pilot.' };
    return { configured: true, reachable: false, url, detail: `Sumagot ang Kaggle Pilot ng ${res.status} sa /health.` };
  } catch (error: any) {
    return {
      configured: true,
      reachable: false,
      url,
      detail: `Hindi maabot ang Kaggle Pilot sa ${url} (${error?.message || 'error'}).`,
    };
  }
}

/** True when the Kaggle Pilot answers right now. */
export async function pilotReady(): Promise<boolean> {
  return (await pilotStatus()).reachable;
}

/** POST one JSON body to the worker, or throw `PilotUnavailable`. */
async function pilotPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const url = pilotUrl();
  if (!url) {
    throw new PilotUnavailable(
      'Hindi naka-set ang KAGGLE_PILOT_URL. I-set ito sa Cloudflare tunnel URL ng Kaggle Notebook.',
    );
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.KAGGLE_PILOT_TOKEN) headers.Authorization = `Bearer ${process.env.KAGGLE_PILOT_TOKEN}`;

  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(pilotTimeoutMs()),
    });
  } catch (error: any) {
    throw new PilotUnavailable(`Hindi maabot ang Kaggle Pilot sa ${url}${path} (${error?.message || 'error'}).`);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const tail = text ? `: ${text.slice(0, 200)}` : '';
    throw new PilotUnavailable(`Sumagot ang Kaggle Pilot ng ${res.status} sa ${path}${tail}.`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    // A worker that answers with bare text is still usable.
    return text;
  }
}

function str(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Pull the first non-empty string under any of `keys`, walking nested objects. */
function pickText(payload: unknown, keys: string[]): string {
  if (typeof payload === 'string') return payload.trim();
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = pickText(item, keys);
      if (found) return found;
    }
    return '';
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of keys) {
      if (typeof obj[key] === 'string' && (obj[key] as string).trim()) return (obj[key] as string).trim();
    }
    for (const nested of ['data', 'result', 'output', 'response', 'payload']) {
      if (obj[nested] !== undefined) {
        const found = pickText(obj[nested], keys);
        if (found) return found;
      }
    }
  }
  return '';
}

/** Find a scene array anywhere in the reply. */
function sceneList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.scenes)) return obj.scenes;
    if (Array.isArray(obj.breakdown)) return obj.breakdown;
    for (const nested of ['data', 'result', 'output', 'response', 'payload']) {
      if (obj[nested] !== undefined) {
        const found = sceneList(obj[nested]);
        if (found.length) return found;
      }
    }
  }
  return [];
}

/** Normalise the worker's scene objects to the shape `mergeScenes` expects. */
function pickScenes(payload: unknown): PilotScene[] {
  const scenes: PilotScene[] = [];
  for (const raw of sceneList(payload)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const heading = str(s.heading ?? s.title ?? s.scene ?? s.name);
    const narration = str(s.narration ?? s.voiceover ?? s.voice_over ?? s.dialogue ?? s.text);
    const visual = str(s.visual ?? s.description ?? s.shot ?? s.action);
    const mood = str(s.mood ?? s.tone);
    if (!heading && !narration && !visual) continue;
    scenes.push({ heading, narration, visual, mood });
  }
  return scenes;
}

/** Generate the full screenplay from one brief. Throws `PilotUnavailable`. */
export async function generateScript(brief: string): Promise<string> {
  const payload = await pilotPost(endpointPath('script'), { brief });
  const script = pickText(payload, ['script', 'screenplay', 'text', 'result', 'output', 'content']);
  if (!script) throw new PilotUnavailable('Walang script sa sagot ng Kaggle Pilot.');
  return script;
}

/** Generate the character bible from the screenplay. Throws `PilotUnavailable`. */
export async function generateCharacterBible(script: string): Promise<string> {
  const payload = await pilotPost(endpointPath('bible'), { script });
  const bible = pickText(payload, [
    'bible', 'character_bible', 'characterBible', 'characters', 'text', 'result', 'output', 'content',
  ]);
  if (!bible) throw new PilotUnavailable('Walang character bible sa sagot ng Kaggle Pilot.');
  return bible;
}

/** Break the screenplay into scenes. Throws `PilotUnavailable`. */
export async function breakdownScenes(script: string): Promise<PilotScene[]> {
  const payload = await pilotPost(endpointPath('scenes'), { script });
  const scenes = pickScenes(payload);
  if (scenes.length === 0) throw new PilotUnavailable('Walang eksena sa breakdown ng Kaggle Pilot.');
  return scenes;
}
