/**
 * One text router for every AI feature: Director's Chair, the VIP Battle Room,
 * and the Feature Film Factory all ask here instead of talking to a provider.
 *
 * Keys are read from `process.env` at call time, never stored in source, and
 * every error message is scrubbed before it can reach a log or an HTTP body.
 * Provider order is Gemini, DeepSeek, Claude, then local Ollama; the first one
 * that answers wins. When none can, the caller gets `AiUnavailableError`, which
 * the HTTP layer turns into an honest 503 — nothing is ever fabricated.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type TextProvider = 'gemini' | 'deepseek' | 'claude' | 'ollama';

export interface RouterResult {
  text: string;
  provider: TextProvider;
  model: string;
}

export interface RouterOptions {
  /** Ask for JSON. Applied where the provider supports it. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

/** Which provider answered, and why the others did not. Never holds a key. */
export class AiUnavailableError extends Error {
  readonly code = 'AI_UNAVAILABLE';
  readonly attempts: string[];

  constructor(attempts: string[]) {
    super(
      attempts.length === 0
        ? 'AI_UNAVAILABLE: no text provider is configured'
        : `AI_UNAVAILABLE: all configured text providers failed (${attempts.join(' | ')})`,
    );
    this.name = 'AiUnavailableError';
    this.attempts = attempts;
  }
}

/** Keys that must never appear in a message we log or return. */
function secretValues(): string[] {
  return [
    process.env.GEMINI_API_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.APP_AUTH_TOKEN,
    process.env.KAGGLE_PILOT_TOKEN,
  ].filter((s): s is string => typeof s === 'string' && s.trim().length > 4);
}

/**
 * Strip secrets from an error message. Env values are removed by exact match,
 * and known key shapes are removed by pattern, because a provider can echo a
 * key back in an error body that was never in our environment.
 */
export function sanitizeError(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secretValues()) {
    msg = msg.split(secret).join('[REDACTED]');
  }
  return msg
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/sk-ant-[0-9A-Za-z_-]{10,}/g, '[REDACTED]')
    .replace(/\bsk-[0-9A-Za-z]{20,}/g, '[REDACTED]')
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[0-9A-Za-z._-]{10,}/gi, '$1[REDACTED]');
}

function apiKey(name: 'GEMINI_API_KEY' | 'DEEPSEEK_API_KEY' | 'ANTHROPIC_API_KEY'): string {
  return (process.env[name] || '').trim();
}

/**
 * Ollama needs no key and has a default URL, so it counts as configured unless
 * it is explicitly switched off. Whether it actually answers is decided by the
 * call, not by this check.
 */
function ollamaEnabled(): boolean {
  return process.env.OLLAMA_DISABLE !== '1';
}

/** Base URL for a provider, overridable so a proxy or a test server can stand in. */
function providerBaseUrl(envName: string, fallback: string): string {
  const raw = (process.env[envName] || '').trim();
  return (raw || fallback).replace(/\/+$/, '');
}

function ollamaBaseUrl(): string {
  const raw = process.env.LOCAL_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  return raw.trim().replace(/\/+$/, '');
}

function ollamaModelName(): string {
  return (process.env.OLLAMA_MODEL || 'qwen2.5:7b').trim();
}

/** Providers that have everything they need to be tried right now. */
export function configuredTextProviders(): TextProvider[] {
  const providers: TextProvider[] = [];
  if (apiKey('GEMINI_API_KEY')) providers.push('gemini');
  if (apiKey('DEEPSEEK_API_KEY')) providers.push('deepseek');
  if (apiKey('ANTHROPIC_API_KEY')) providers.push('claude');
  if (ollamaEnabled()) providers.push('ollama');
  return providers;
}

export function hasConfiguredTextProvider(): boolean {
  return configuredTextProviders().length > 0;
}

/** Split the system turn off; every provider wants it in a different place. */
function splitSystem(messages: ChatMessage[]): { system: string; turns: ChatMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim();
  return { system, turns: messages.filter((m) => m.role !== 'system') };
}

async function readErrorBody(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return body ? `: ${sanitizeError(body).slice(0, 300)}` : '';
}

/** Gemini model order: the app's own list first, then the documented default. */
function geminiModels(): string[] {
  const fromEnv = (process.env.GEMINI_TEXT_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const base = fromEnv.length > 0
    ? fromEnv
    : ['gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-2.5-flash'];
  return [...new Set(base)];
}

function isRetryableModelError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('no longer available') ||
    m.includes('not_found') ||
    m.includes('not found') ||
    m.includes('high demand') ||
    m.includes('overloaded') ||
    m.includes('rate limit') ||
    m.includes('429') ||
    m.includes('503') ||
    m.includes('unavailable')
  );
}

async function callGemini(messages: ChatMessage[], opts: RouterOptions): Promise<RouterResult> {
  const key = apiKey('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not set');

  const { system, turns } = splitSystem(messages);
  const contents = turns.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  let lastError: Error | null = null;
  for (const model of geminiModels()) {
    try {
      const res = await fetch(
        `${providerBaseUrl('GEMINI_API_BASE', 'https://generativelanguage.googleapis.com')}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents,
            generationConfig: {
              temperature: opts.temperature ?? 0.7,
              maxOutputTokens: opts.maxTokens ?? 2048,
              ...(opts.json ? { responseMimeType: 'application/json' } : {}),
            },
          }),
          signal: AbortSignal.timeout(120000),
        },
      );
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}${await readErrorBody(res)}`);
      const data = (await res.json()) as any;
      const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
      if (!text) throw new Error('Gemini returned an empty response');
      return { text, provider: 'gemini', model };
    } catch (error: any) {
      lastError = error;
      if (!isRetryableModelError(error?.message || '')) break;
    }
  }
  throw lastError ?? new Error('No Gemini text model answered');
}

async function callDeepSeek(messages: ChatMessage[], opts: RouterOptions): Promise<RouterResult> {
  const key = apiKey('DEEPSEEK_API_KEY');
  if (!key) throw new Error('DEEPSEEK_API_KEY is not set');

  const model = (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim();
  const res = await fetch(`${providerBaseUrl('DEEPSEEK_API_BASE', 'https://api.deepseek.com')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}${await readErrorBody(res)}`);
  const data = (await res.json()) as any;
  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('DeepSeek returned an empty response');
  return { text, provider: 'deepseek', model };
}

async function callClaude(messages: ChatMessage[], opts: RouterOptions): Promise<RouterResult> {
  const key = apiKey('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');

  const model = (process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest').trim();
  const { system, turns } = splitSystem(messages);
  const res = await fetch(`${providerBaseUrl('ANTHROPIC_API_BASE', 'https://api.anthropic.com')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      messages: turns.map((m) => ({ role: m.role, content: m.content })),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}${await readErrorBody(res)}`);
  const data = (await res.json()) as any;
  const text = String(data?.content?.[0]?.text ?? '').trim();
  if (!text) throw new Error('Claude returned an empty response');
  return { text, provider: 'claude', model };
}

async function callOllama(messages: ChatMessage[], opts: RouterOptions): Promise<RouterResult> {
  if (process.env.OLLAMA_DISABLE === '1') throw new Error('Ollama is disabled (OLLAMA_DISABLE=1)');

  const model = ollamaModelName();
  const res = await fetch(`${ollamaBaseUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      ...(opts.json ? { format: 'json' } : {}),
      options: {
        temperature: opts.temperature ?? 0.7,
        num_ctx: 8192,
      },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}${await readErrorBody(res)}`);
  const data = (await res.json()) as any;
  const text = String(data?.message?.content ?? '').trim();
  if (!text) throw new Error('Ollama returned an empty response');
  return { text, provider: 'ollama', model };
}

const CALLERS: Record<TextProvider, (m: ChatMessage[], o: RouterOptions) => Promise<RouterResult>> = {
  gemini: callGemini,
  deepseek: callDeepSeek,
  claude: callClaude,
  ollama: callOllama,
};

const LABELS: Record<TextProvider, string> = {
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  claude: 'Claude',
  ollama: 'Ollama',
};

/**
 * One completion from the first provider that works. Throws
 * `AiUnavailableError` only after every configured provider has failed, and the
 * message names each failure without exposing a key.
 */
export async function generateTextWithFallback(
  messages: ChatMessage[],
  opts: RouterOptions = {},
): Promise<RouterResult> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('generateTextWithFallback needs at least one message');
  }

  const attempts: string[] = [];
  for (const provider of configuredTextProviders()) {
    try {
      return await CALLERS[provider](messages, opts);
    } catch (error) {
      attempts.push(`${LABELS[provider]}: ${sanitizeError(error)}`);
    }
  }
  throw new AiUnavailableError(attempts);
}

/** True when `error` is the router's "nothing answered" signal. */
export function isAiUnavailable(error: unknown): error is AiUnavailableError {
  return error instanceof AiUnavailableError;
}
