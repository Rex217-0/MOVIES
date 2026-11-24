/**
 * Shared API client.
 *
 * The token is read from a `?token=` query parameter on first load and kept in
 * sessionStorage, so the app works behind the bearer-token middleware without a
 * login screen. The SSE thought stream cannot set headers, so instead of putting
 * that long-lived token in the URL we mint a short-lived ticket and use that.
 */

const TOKEN_STORAGE_KEY = 'direk_auth_token';
const SERVER_URL_STORAGE_KEY = 'direk_server_url';

/**
 * Base URL of the API server.
 *
 * Two sources, in priority order:
 *  1. A runtime override — set from `?server=` on first load, or typed into the
 *     Setup panel. Kept in localStorage. This is what makes the installed
 *     Android app configurable without a rebuild.
 *  2. The build-time `VITE_API_BASE_URL`, baked into the bundle.
 *
 * Empty means "same origin": the browser build served by the app itself keeps
 * using relative `/api/...` URLs. The Capacitor Android build loads the web app
 * from `https://localhost`, where a relative URL would hit the WebView, not
 * Server-2 — so it needs one of the two sources above.
 */
export function normalizeApiBaseUrl(raw: string | undefined | null): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

/** A runtime override always wins over the baked value. */
export function resolveApiBaseUrl(runtime: string | undefined | null, baked: string | undefined | null): string {
  return normalizeApiBaseUrl(runtime) || normalizeApiBaseUrl(baked);
}

/** The server address the user typed (or passed as `?server=`), if any. */
export function getServerUrl(): string {
  try {
    const url = new URL(window.location.href);
    const param = url.searchParams.get('server');
    if (param) {
      const normalized = normalizeApiBaseUrl(param);
      localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized);
      url.searchParams.delete('server');
      window.history.replaceState({}, '', url.toString());
      return normalized;
    }
  } catch {
    // Non-browser environment.
  }
  try {
    return normalizeApiBaseUrl(localStorage.getItem(SERVER_URL_STORAGE_KEY));
  } catch {
    return '';
  }
}

/** Persist the server address. An empty value clears the override. */
export function setServerUrl(raw: string): string {
  const normalized = normalizeApiBaseUrl(raw);
  try {
    if (normalized) localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized);
    else localStorage.removeItem(SERVER_URL_STORAGE_KEY);
  } catch {
    // Non-browser environment.
  }
  return normalized;
}

/** The build-time base baked into the bundle, empty when the build set none. */
export function bakedApiBaseUrl(): string {
  try {
    return normalizeApiBaseUrl((import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE_URL);
  } catch {
    return '';
  }
}

/**
 * The base URL the native Android shell injects before the app boots.
 *
 * The legacy WebView shell loads the UI from inside the APK, where a relative
 * `/api` would resolve against the APK itself, so it writes the server the user
 * configured into this global. The Capacitor build does not use it, but keeping
 * the read here means both shells work and neither needs a rebuild to change
 * servers.
 */
function injectedApiBaseUrl(): string {
  try {
    const base = (window as { __MOVIE_CREATOR_API_BASE__?: string }).__MOVIE_CREATOR_API_BASE__;
    return normalizeApiBaseUrl(base);
  } catch {
    return '';
  }
}

export function apiBaseUrl(): string {
  return resolveApiBaseUrl(getServerUrl(), injectedApiBaseUrl()) || bakedApiBaseUrl();
}

/**
 * Resolve an API path against the configured base. Absolute URLs (another host)
 * and already-qualified paths pass through untouched. `base` is injectable so
 * the join logic is testable without touching `import.meta.env` or localStorage.
 */
export function apiUrl(path: string, base: string = apiBaseUrl()): string {
  if (!path.startsWith('/')) return path;
  return base ? `${base}${path}` : path;
}

function readTokenFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (token) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url.toString());
      return token;
    }
  } catch {
    // Non-browser environment.
  }
  return null;
}

export function getAuthToken(): string {
  try {
    return readTokenFromUrl() ?? sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** fetch wrapper that attaches the bearer token. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(apiUrl(input), { ...init, headers });
}

/**
 * URL for the SSE thought stream. When a token is configured, ask the server for
 * a short-lived ticket first and put only that in the URL (Blocker E). Falls
 * back to the plain URL when no auth is configured.
 */
export async function thoughtStreamUrl(): Promise<string> {
  const token = getAuthToken();
  const plain = apiUrl('/api/pilot/thought-stream');
  if (!token) return plain;
  try {
    const res = await apiFetch('/api/pilot/stream-ticket', { method: 'POST' });
    if (!res.ok) return plain;
    const data = (await res.json()) as { ticket?: string };
    if (!data.ticket) return plain;
    return `${plain}?ticket=${encodeURIComponent(data.ticket)}`;
  } catch {
    return plain;
  }
}

// ---------------------------------------------------------------------------
// Direk (AI Movie Director) endpoints
// ---------------------------------------------------------------------------

export interface DirekChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CatalogTitle {
  title: string;
  type: string;
  listed_in: string;
  release_year: string;
  duration: string;
  director?: string;
  cast?: string;
  source: string;
  rating?: number;
  budget?: number;
  worldwide_gross?: number;
}

export interface SkillAction {
  skill: string;
  connector: string;
  args: Record<string, unknown>;
  needs_confirm: boolean;
  status: 'needs_confirm' | 'ready';
}

export interface ConnectorRunResult {
  skill: string;
  ok: boolean;
  note: string;
  assets: { id: string; name: string; kind: string; bytes: number; title: string; mime: string }[];
  download?: { name: string; mime: string };
  data?: unknown;
}

export interface DirekChatResult {
  status: 'success';
  model: string;
  reply: string;
  reference_genre: string | null;
  references: CatalogTitle[];
  gate: string | null;
  action: SkillAction | null;
  action_error: string | null;
  connector: ConnectorRunResult | null;
  /** Stable per-browser thread id; the server echoes the one it stored under. */
  threadId?: string;
  turnId?: string;
  /** True only when the turn really reached a store. */
  persisted?: boolean;
}

export interface DirekStatus {
  ok: boolean;
  model: string;
  gemini_key_configured: boolean;
  pipeline: { id: string; name: string; description: string }[];
  genres: string[];
  skills: { id: string; kind: 'local' | 'api'; connector?: string; confirm?: boolean }[];
  reference_available: boolean;
  reference_rows: number;
  reference_sources: Record<string, number>;
  persona: string;
  market_available?: boolean;
  image_backend?: 'comfyui' | 'gemini' | 'none';
  comfyui_url?: string;
}

/** A structured failure from an AI endpoint (HTTP 503 AI_UNAVAILABLE). */
export class AiUnavailableError extends Error {
  code: string;
  model: string;
  constructor(body: { error?: string; code?: string; model?: string; detail?: string }) {
    super(body.error || 'The AI service is unavailable.');
    this.code = body.code || 'AI_UNAVAILABLE';
    this.model = body.model || '';
  }
}

export async function direkStatus(): Promise<DirekStatus> {
  const res = await apiFetch('/api/direk/status');
  if (!res.ok) throw new Error(`Status request failed (${res.status})`);
  return res.json();
}

export async function direkChat(
  messages: DirekChatMessage[],
  threadId?: string,
): Promise<DirekChatResult> {
  const res = await apiFetch('/api/direk/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, threadId }),
  });
  if (res.status === 503) throw new AiUnavailableError(await res.json());
  if (!res.ok) throw new Error(`Direk request failed (${res.status})`);
  return res.json();
}

export interface StoredChatTurn {
  turnId: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

/**
 * The last turns of a thread, oldest first. Returns an empty list when the
 * request fails, so a cold backend never blocks the page from rendering.
 */
export async function direkChatHistory(threadId: string): Promise<StoredChatTurn[]> {
  const res = await apiFetch(`/api/direk/chat/history?threadId=${encodeURIComponent(threadId)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.turns) ? data.turns : [];
}

export async function direkReference(genre: string, n = 5): Promise<CatalogTitle[]> {
  const res = await apiFetch(`/api/direk/reference?genre=${encodeURIComponent(genre)}&n=${n}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.items ?? [];
}

export interface ShareStat {
  name: string;
  movies: string;
  marketShare: string;
}

export interface MarketIntel {
  available: boolean;
  brief: string;
  top_genres: ShareStat[];
  top_distributors: ShareStat[];
  production_methods: ShareStat[];
  ratings: ShareStat[];
}

export async function direkMarket(): Promise<MarketIntel | null> {
  const res = await apiFetch('/api/direk/market');
  if (!res.ok) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// LoRA training sets
// ---------------------------------------------------------------------------

export interface LoraBriefInput {
  title: string;
  genre: string;
  mood: string;
  durationMinutes?: number;
  trigger?: string;
  character?: { name?: string; look?: string; wardrobe?: string; voice?: string };
  baseModel?: string;
  /** Ask the server to generate sample images too (default: true). */
  images?: boolean;
  /** Name of a published LoRA to apply while generating images. */
  lora?: string;
  /** LoRA blend strength, default 1. */
  loraStrength?: number;
}

export interface LoraPlanResult {
  trigger: string;
  genre: string;
  mood: string;
  samples: number;
  character: { name: string; look?: string; wardrobe?: string; voice?: string };
  base_model: string;
  references: CatalogTitle[];
  notes: string[];
  artifacts: string[];
  images_available: boolean;
  image_backend: 'comfyui' | 'gemini' | 'none';
  max_images: number;
}

export async function direkLoraPlan(input: LoraBriefInput): Promise<LoraPlanResult> {
  const res = await apiFetch('/api/direk/lora/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `LoRA plan failed (${res.status})`);
  }
  return res.json();
}

export interface TrainJob {
  id: string;
  title: string;
  trigger: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  outputDir: string;
  artifact?: string;
  error?: string;
  log: string[];
}

export interface TrainStatus {
  available: boolean;
  dir: string;
  script: string | null;
  python: string;
  base_model: string | null;
  output_dir: string;
  /** Which trainer is live: `local` kohya_ss, or `colab` through Drive. */
  backend?: 'local' | 'colab';
  reason?: string;
  job: TrainJob | null;
}

export async function direkTrainStatus(): Promise<TrainStatus> {
  const res = await apiFetch('/api/direk/train/status');
  if (!res.ok) throw new Error(`Train status failed (${res.status})`);
  return res.json();
}

export async function direkTrainStart(
  input: LoraBriefInput & { epochs?: number; resolution?: number; networkDim?: number; numRepeats?: number },
): Promise<{ status: string; job: TrainJob }> {
  const res = await apiFetch('/api/direk/train/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Training failed to start (${res.status})`);
  return body;
}

export async function direkTrainCancel(): Promise<boolean> {
  const res = await apiFetch('/api/direk/train/cancel', { method: 'POST' });
  if (!res.ok) return false;
  return (await res.json()).cancelled === true;
}

/** URL for the live training log stream, with the token as a query parameter. */
export function trainStreamUrl(): string {
  const token = getAuthToken();
  return token
    ? apiUrl(`/api/direk/train/stream?token=${encodeURIComponent(token)}`)
    : apiUrl('/api/direk/train/stream');
}

export interface LoraFile {
  name: string;
  bytes: number;
  modified: string;
}

export interface DirekSettings {
  comfyui_url?: string;
  comfyui_enabled?: boolean;
  comfyui_checkpoint?: string;
  comfyui_workflow?: string;
  comfyui_video_workflow?: string;
  comfyui_loras_dir?: string;
  kohya_dir?: string;
  kohya_base_model?: string;
  kohya_python?: string;
  kohya_accelerate?: boolean;
  kohya_output_dir?: string;
  ollama_url?: string;
  ollama_model?: string;
  /** Cloudflare tunnel to the Kaggle heavy worker; changes on every run. */
  kaggle_pilot_url?: string;
}

export interface SetupReport {
  config_path: string;
  text: {
    backend: 'gemini' | 'ollama' | 'none';
    gemini_key: boolean;
    model: string;
    ready: boolean;
    ollama: {
      url: string;
      model: string;
      reachable: boolean;
      model_present: boolean;
      models: string[];
      error?: string;
    };
  };
  comfyui: {
    url: string;
    reachable: boolean;
    checkpoints: string[];
    loras: string[];
    error?: string;
    video_workflow: string;
    video_workflow_exists: boolean;
  };
  trainer: { available: boolean; reason?: string; base_model: string | null };
  loras_dir: string;
  published_loras: LoraFile[];
  ready: boolean;
}

export async function direkGetSettings(): Promise<{ config_path: string; settings: DirekSettings }> {
  const res = await apiFetch('/api/direk/settings');
  if (!res.ok) throw new Error(`Settings failed (${res.status})`);
  return res.json();
}

export async function direkSaveSettings(settings: DirekSettings): Promise<{ config_path: string; settings: DirekSettings }> {
  const res = await apiFetch('/api/direk/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
  return body;
}

export async function direkSetup(): Promise<SetupReport> {
  const res = await apiFetch('/api/direk/setup');
  if (!res.ok) throw new Error(`Setup check failed (${res.status})`);
  return res.json();
}

export async function direkLoraList(): Promise<{ dir: string; loras: LoraFile[] }> {
  const res = await apiFetch('/api/direk/lora/list');
  if (!res.ok) return { dir: '', loras: [] };
  return res.json();
}

/** Fetch the LoRA training set zip as a blob for download. */
export async function direkLoraDataset(input: LoraBriefInput): Promise<Blob> {
  const res = await apiFetch('/api/direk/lora/dataset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `LoRA dataset failed (${res.status})`);
  }
  return res.blob();
}

export interface HarvestResult {
  ok: boolean;
  saved: number;
  requested: number;
  trigger: string;
  targetDir: string;
  sources: string[];
  usedQueries?: Record<string, string>;
  samples: { file: string; source: string; bytes: number }[];
  failures: { source: string; url: string; reason: string }[];
  note: string;
  error?: string;
}

/**
 * Harvest free images from Wallhaven, Openverse and Wikimedia into a LoRA
 * dataset. A run that saved nothing is reported as an error, not a success.
 */
export async function direkHarvestLoraImages(input: {
  query: string;
  triggerToken: string;
  count?: number;
}): Promise<HarvestResult> {
  const res = await apiFetch('/api/extensions/season-01-harvester/harvest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(body.error || body.note || `Harvest failed (${res.status})`);
  }
  return body;
}

export interface SeasonalGenreResult {
  genre: string;
  target: number;
  approved: number;
  rejected: number;
  complete: boolean;
}

export interface SeasonalHarvestResult {
  ok: boolean;
  batchSlug: string;
  theme: string;
  requested: number;
  approved: number;
  rejected: number;
  perGenre: SeasonalGenreResult[];
  note: string;
}

/** One seasonal sweep: every genre, Bodegero QC, rejects quarantined. */
export async function direkSeasonalHarvest(input: {
  batchSlug?: string;
  theme?: string;
  genres?: string[];
  perGenreCount?: number;
}): Promise<SeasonalHarvestResult> {
  const res = await apiFetch('/api/extensions/season-01-harvester/harvest-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || body.note || `Seasonal harvest failed (${res.status})`);
  }
  return body;
}

export interface HarvestSchedule {
  enabled: boolean;
  hour: number;
  minute: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  month: number | null;
  theme: string;
  genres: string[];
  perGenreCount: number;
  defaults?: { genres: string[]; perGenreCount: number };
}

export async function direkGetHarvestSchedule(): Promise<HarvestSchedule> {
  const res = await apiFetch('/api/extensions/season-01-harvester/schedule');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Could not load schedule (${res.status})`);
  return body;
}

export async function direkSaveHarvestSchedule(schedule: HarvestSchedule): Promise<HarvestSchedule> {
  const res = await apiFetch('/api/extensions/season-01-harvester/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedule),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Could not save schedule (${res.status})`);
  return body;
}

export interface Wan22Status {
  ok: boolean;
  comfyUrl: string;
  reachable: boolean;
  workflowPresent: boolean;
  missingModels: string[];
  note: string;
  models: { unet: string; clip: string; vae: string };
}

export async function direkWan22Status(): Promise<Wan22Status> {
  // 503 still carries a useful body (what is missing), so it is not thrown away.
  const res = await apiFetch('/api/extensions/season-01-wan22/status');
  const body = await res.json().catch(() => ({}));
  if (!body || typeof body.ok !== 'boolean') {
    throw new Error(body?.error || `Could not check Wan 2.2 (${res.status})`);
  }
  return body;
}

export interface LoraDatasetInfo {
  triggerToken: string;
  dir: string;
  images: number;
  captions: number;
  orphanCaptions: number;
  uncaptioned: number;
  ready: boolean;
  bytes: number;
  /** Captioned images per genre, derived from the harvester's filenames. */
  genres?: Record<string, number>;
}

export async function direkLoraDatasets(): Promise<{
  runs_root: string;
  preset: { query: string; triggerToken: string; count: number };
  datasets: LoraDatasetInfo[];
}> {
  const res = await apiFetch('/api/direk/lora/datasets');
  if (!res.ok) throw new Error(`Datasets failed (${res.status})`);
  return res.json();
}

/** Download URL for a saved asset, with the token attached. */
export function assetDownloadUrl(name: string): string {
  const token = getAuthToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return apiUrl(`/api/direk/assets/${encodeURIComponent(name)}/download${query}`);
}

// ---------------------------------------------------------------------------
// Render Vault (staging review)
// ---------------------------------------------------------------------------

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface AssetItem {
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
  reviewStatus?: ReviewStatus;
}

export async function direkAssets(): Promise<AssetItem[]> {
  const res = await apiFetch('/api/direk/assets');
  if (!res.ok) throw new Error(`Assets request failed (${res.status})`);
  const data = await res.json();
  return data.assets ?? [];
}

export async function direkReviewAsset(
  id: string,
  action: 'approve' | 'reject' | 'pending',
): Promise<AssetItem> {
  const res = await apiFetch('/api/direk/assets/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Review failed (${res.status})`);
  return body.asset as AssetItem;
}

// ---------------------------------------------------------------------------
// Task routing (T1/T2/T3)
// ---------------------------------------------------------------------------

export interface TaskRoute {
  task: string;
  tier: 'T1' | 'T2' | 'T3';
  placement: 'local' | 'cloud';
  reason: string;
}

export interface RoutingReport {
  tiers: Record<string, string>;
  t3_allow_local: boolean;
  cloud_configured: boolean;
  table: { task: string; tier: 'T1' | 'T2' | 'T3'; placement: 'local' | 'cloud' }[];
}

export async function direkRouting(): Promise<RoutingReport | null> {
  const res = await apiFetch('/api/direk/routing');
  if (!res.ok) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Live system map (Radar tab). Each call really probes every node.
// ---------------------------------------------------------------------------

export type NodeStatus = 'active' | 'error' | 'standby' | 'dead';
export type NodeLayer = 'center' | 'behind' | 'left' | 'right' | 'front';

export interface MapNode {
  id: string;
  name: string;
  kind: 'core' | 'ai' | 'local' | 'cloud' | 'storage' | 'training' | 'agent';
  layer: NodeLayer;
  wired: boolean;
  wire?: string;
  status: NodeStatus;
  detail: string;
  latency_ms?: number;
  probe: string;
  role: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface SystemMap {
  checked_at: string;
  center: string;
  counts: Record<NodeStatus, number>;
  nodes: MapNode[];
}

export async function direkSystemMap(): Promise<SystemMap | null> {
  const res = await apiFetch('/api/direk/system-map');
  if (!res.ok) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Movie Creator
// ---------------------------------------------------------------------------

export interface MovieJobView {
  id: string;
  brief: string;
  minutes: number;
  stage: string;
  percent: number;
  detail?: string;
  status: 'running' | 'done' | 'error';
  title?: string;
  scenes?: number;
  seconds?: number;
  narrated?: boolean;
  voiceSource?: 'fish' | 'gemini' | 'tagalog' | 'piper' | 'none';
  note?: string;
  asset?: { name: string; bytes: number; kind: string; title: string };
  /** What the screenplay was grounded in (real datasets), when available. */
  grounding?: { genre: string | null; references: number; market: boolean; pacing: string };
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface MovieStatus {
  available: boolean;
  narration: boolean;
  narration_fish: boolean;
  narration_cloud: boolean;
  narration_tagalog: boolean;
  narration_offline: boolean;
  piper_voice?: string;
  tagalog_model?: string;
  tagalog_python?: string;
  tts_model: string;
  voices: string[];
  moods: string[];
  min_minutes: number;
  max_minutes: number;
  ffmpeg: boolean;
  jobs: MovieJobView[];
}

export async function movieStatus(): Promise<MovieStatus> {
  const res = await apiFetch('/api/direk/movie/status');
  if (!res.ok) throw new Error(`Movie status failed (${res.status})`);
  return res.json();
}

export async function movieStart(input: {
  brief: string;
  minutes: number;
  mood?: string;
  voice?: string;
}): Promise<{ job: string }> {
  const res = await apiFetch('/api/direk/movie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Movie start failed (${res.status})`);
  return body;
}

/** Poll one job until it settles, reporting progress as it goes. */
export async function movieWait(
  id: string,
  onProgress?: (job: MovieJobView) => void,
  intervalMs = 2000,
  timeoutMs = 30 * 60 * 1000,
): Promise<MovieJobView> {
  const deadline = Date.now() + timeoutMs;
  let last: MovieJobView | null = null;
  while (Date.now() < deadline) {
    const status = await movieStatus();
    const job = status.jobs.find(j => j.id === id);
    if (job) {
      last = job;
      onProgress?.(job);
      if (job.status !== 'running') return job;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  if (last) return last;
  throw new Error('Hindi natapos ang pelikula sa oras.');
}

// ---------------------------------------------------------------------------
// Feature Film Factory (18 scenes -> one 90-minute feature)
// ---------------------------------------------------------------------------

export interface FeatureSceneView {
  index: number;
  act: number;
  heading: string;
  beat: string;
  narration: string;
  visual: string;
  mood: string;
  status: 'pending' | 'rendering' | 'rendered' | 'failed' | 'approved' | 'rejected';
  /** Which pipeline stage the scene is in (scripting -> rendering -> audio -> completed). */
  stage: 'scripting' | 'rendering' | 'audio' | 'completed';
  percent: number;
  seconds: number;
  assetId?: string;
  assetName?: string;
  /** Public URL of the scene file in the local render store (/renders/...). */
  renderUrl?: string;
  error?: string;
  route: { task: string; tier: string; placement: string; reason: string };
}

export interface FeatureJobView {
  id: string;
  /** The private vault this job belongs to (`LJRgroupORG`). */
  orgId: string;
  concept: { title: string; genre: string; rating: string; format: string; brief: string };
  status: 'idle' | 'running' | 'paused' | 'done' | 'error';
  percent: number;
  rendered: number;
  failed: number;
  approved: number;
  rejected: number;
  total: number;
  totalSeconds: number;
  currentScene: number;
  renderedSeconds: number;
  filmClock: string;
  totalClock: string;
  scenes: FeatureSceneView[];
  film?: { assetName: string; bytes: number; seconds: number; renderName?: string; renderUrl?: string };
  /** The Kaggle Pilot screenplay this film was built from, when one was fetched. */
  script?: string;
  /** The character bible the Pilot produced for the screenplay. */
  bible?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface FeatureStatus {
  available: boolean;
  scenes: number;
  scene_seconds: number;
  total_seconds: number;
  total_clock: string;
  ratings: string[];
  rating_labels: Record<string, string>;
  formats: string[];
  narration_order: string[];
  ffmpeg: boolean;
  /** The Dual-Pilot: Kaggle (T3 batch) and the local Ollama (T1 fallback). */
  pilot: {
    configured: boolean;
    reachable: boolean;
    url: string;
    detail: string;
    preferred: 'kaggle' | 'local-ollama' | 'none';
    local: { url: string; model: string; reachable: boolean; model_present: boolean; detail: string };
  };
  job: FeatureJobView | null;
}

export async function featureStatus(id?: string): Promise<FeatureStatus> {
  const q = id ? `?id=${encodeURIComponent(id)}` : '';
  const res = await apiFetch(`/api/direk/feature/status${q}`);
  if (!res.ok) throw new Error(`Feature status failed (${res.status})`);
  return res.json();
}

export async function featureCreate(input: {
  brief: string; title?: string; genre?: string; rating?: string; format?: string; mood?: string;
}): Promise<FeatureJobView> {
  const res = await apiFetch('/api/direk/feature/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Feature create failed (${res.status})`);
  return body.job;
}

async function featureAction(path: string, payload: Record<string, unknown>): Promise<FeatureJobView> {
  const res = await apiFetch(`/api/direk/feature/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Feature ${path} failed (${res.status})`);
  return body.job;
}

export const featureStart = (id: string) => featureAction('start', { id });
export const featurePause = (id: string) => featureAction('pause', { id });
export const featureRerender = (id: string, scene: number) => featureAction('rerender', { id, scene });
export const featureAssemble = (id: string) => featureAction('assemble', { id });

/**
 * Ask the Dual-Pilot for the screenplay, character bible and 18-scene
 * breakdown, and store them on the job. Kaggle (T3 heavy batch) is tried
 * first; when it is unset or down the local Ollama (T1) writes the script.
 * Answers an honest `503 PILOT_UNAVAILABLE` only when both are down.
 */
export async function featurePilot(id: string): Promise<{
  job: FeatureJobView;
  script_chars: number;
  bible: boolean;
  scenes: number;
  source: 'kaggle' | 'local-ollama';
  model: string;
}> {
  const res = await apiFetch('/api/direk/feature/pilot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Pilot failed (${res.status})`);
  return body;
}
