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
}

export interface SkillAction {
  skill: string;
  connector: string;
  args: Record<string, unknown>;
  needs_confirm: boolean;
  status: 'needs_confirm' | 'not_connected';
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
