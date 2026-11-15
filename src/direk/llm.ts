/**
 * Text model backends.
 *
 * Two ways to run the text side (Direk chat and the Battle Room directives):
 *
 *   Gemini  — cloud, needs GEMINI_API_KEY (free tier is enough)
 *   Ollama  — fully local and offline, no account and no key. This is the
 *             free path when there is no Gemini key: install Ollama, pull a
 *             model once, and the app talks to it over localhost.
 *
 * The app picks Gemini when a key is present, otherwise Ollama when a server
 * answers. With neither it says so plainly and the endpoints return 503 —
 * nothing is fabricated.
 *
 * Configuration (environment variables):
 *   GEMINI_API_KEY   Enables the Gemini backend
 *   LOCAL_OLLAMA_URL Ollama base URL, default http://127.0.0.1:11434
 *                    (OLLAMA_URL is accepted as an alias)
 *   OLLAMA_MODEL     Model to use, default qwen2.5:7b
 *   OLLAMA_DISABLE   Set to 1 to ignore Ollama even when it is running
 */

export type TextBackend = 'gemini' | 'ollama' | 'none';

export function ollamaUrl(): string {
  return (process.env.LOCAL_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

export function ollamaModel(): string {
  return process.env.OLLAMA_MODEL || 'qwen2.5:7b';
}

export interface OllamaStatus {
  reachable: boolean;
  url: string;
  model: string;
  models: string[];
  model_present: boolean;
  error?: string;
}

/**
 * Are these the same Ollama model? An untagged name means `:latest`, so
 * `llama3` and `llama3:latest` match. A different tag (`qwen2.5:3b` vs
 * `qwen2.5:7b`) is a different model and must NOT match: reporting a pulled 3B
 * as satisfying a request for 7B makes the status lie, and the call then fails.
 */
function sameModel(a: string, b: string): boolean {
  const withLatest = (s: string) => (s.includes(':') ? s : `${s}:latest`);
  return withLatest(a) === withLatest(b);
}

/** Is Ollama up, and is the chosen model pulled? */
export async function ollamaStatus(): Promise<OllamaStatus> {
  const url = ollamaUrl();
  const model = ollamaModel();
  if (process.env.OLLAMA_DISABLE === '1') {
    return { reachable: false, url, model, models: [], model_present: false, error: 'Ollama is disabled (OLLAMA_DISABLE=1)' };
  }
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) {
      return { reachable: false, url, model, models: [], model_present: false, error: `Ollama returned ${res.status}` };
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models || []).map(m => m.name);
    const present = models.some(m => sameModel(m, model));
    return { reachable: true, url, model, models, model_present: present };
  } catch (error: any) {
    return { reachable: false, url, model, models: [], model_present: false, error: error?.message || 'Ollama unreachable' };
  }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaOptions {
  system?: string;
  messages: OllamaMessage[];
  temperature?: number;
  json?: boolean;
  /** Requested context window; Ollama defaults are small. */
  numCtx?: number;
}

/**
 * One chat completion from Ollama. Throws with a plain message on any failure
 * so the caller can report it honestly.
 */
export async function ollamaChat(opts: OllamaOptions): Promise<string> {
  const messages: OllamaMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push(...opts.messages);

  const body: Record<string, unknown> = {
    model: ollamaModel(),
    messages,
    stream: false,
    options: {
      temperature: opts.temperature ?? 0.7,
      num_ctx: opts.numCtx ?? 8192,
    },
  };
  if (opts.json) body.format = 'json';

  const res = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama /api/chat returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content || '';
}

/** Which text backend should serve a request right now. */
export function preferredTextBackend(): TextBackend {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OLLAMA_DISABLE !== '1') return 'ollama';
  return 'none';
}
