/**
 * Shared API client.
 *
 * The token is read from a `?token=` query parameter on first load and kept in
 * sessionStorage, so the app works behind the bearer-token middleware without a
 * login screen. EventSource cannot set headers, so the same token is appended
 * to the thought-stream URL.
 */

const TOKEN_STORAGE_KEY = 'direk_auth_token';

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
  return fetch(input, { ...init, headers });
}

/** URL for the SSE thought stream, with the token as a query parameter. */
export function thoughtStreamUrl(): string {
  const token = getAuthToken();
  return token
    ? `/api/pilot/thought-stream?token=${encodeURIComponent(token)}`
    : '/api/pilot/thought-stream';
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

export async function direkChat(messages: DirekChatMessage[]): Promise<DirekChatResult> {
  const res = await apiFetch('/api/direk/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  if (res.status === 503) throw new AiUnavailableError(await res.json());
  if (!res.ok) throw new Error(`Direk request failed (${res.status})`);
  return res.json();
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
    ? `/api/direk/train/stream?token=${encodeURIComponent(token)}`
    : '/api/direk/train/stream';
}

export interface LoraFile {
  name: string;
  bytes: number;
  modified: string;
}

export interface DirekSettings {
  comfyui_url?: string;
  comfyui_checkpoint?: string;
  comfyui_workflow?: string;
  comfyui_loras_dir?: string;
  kohya_dir?: string;
  kohya_base_model?: string;
  kohya_python?: string;
  kohya_accelerate?: boolean;
  kohya_output_dir?: string;
  ollama_url?: string;
  ollama_model?: string;
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

/** Download URL for a saved asset, with the token attached. */
export function assetDownloadUrl(name: string): string {
  const token = getAuthToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return `/api/direk/assets/${encodeURIComponent(name)}/download${query}`;
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
