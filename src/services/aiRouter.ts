/**
 * One text router for every AI feature: Director's Chair, the VIP Battle Room,
 * and the Feature Film Factory all ask here instead of talking to a provider.
 *
 * Keys are read from `process.env` at call time, never stored in source, and
 * every error message is scrubbed before it can reach a log or an HTTP body.
 * Provider order is Cloudflare AI Gateway (only when CF_ACCOUNT_ID and
 * CF_API_TOKEN are both set), then Gemini, DeepSeek, Claude, then Pollinations
 * (no key, no GPU, no account — the reason a deployment with no paid key can
 * still write), and finally local Ollama; the first one that answers wins. When none can, the caller gets `AiUnavailableError`, which
 * the HTTP layer turns into an honest 503 — nothing is ever fabricated.
 */

import {
  cloudflareChat,
  cloudflareConfigured,
  defaultCloudflareModel,
  isDynamicRouteUnavailable,
} from '../lib/ai.ts';
import { sanitizeError } from '../lib/secrets.ts';

// Re-exported so existing importers keep working after the implementation moved
// to `lib/secrets.ts`, which both this router and the Cloudflare transport use.
export { sanitizeError };

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type TextProvider =
  | 'cloudflare'
  | 'gemini'
  | 'deepseek'
  | 'claude'
  | 'pollinations'
  | 'ollama';

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
  // Front of the chain, but only when the gateway is really set up. An
  // unconfigured gateway must not add a failed hop to every reply.
  if (cloudflareConfigured()) providers.push('cloudflare');
  if (apiKey('GEMINI_API_KEY')) providers.push('gemini');
  if (apiKey('DEEPSEEK_API_KEY')) providers.push('deepseek');
  if (apiKey('ANTHROPIC_API_KEY')) providers.push('claude');
  if (process.env.POLLINATIONS_TEXT_DISABLE !== '1') providers.push('pollinations');
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

/** Claude model order: the app's own list first, then current models. */
function claudeModels(): string[] {
  const fromEnv = (process.env.ANTHROPIC_MODEL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const base = fromEnv.length > 0
    ? fromEnv
    : ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
  return [...new Set(base)];
}

/** The API version header. Pinned by default, overridable for a newer contract. */
function anthropicVersion(): string {
  return (process.env.ANTHROPIC_VERSION || '2026-10-21').trim();
}

async function callClaude(messages: ChatMessage[], opts: RouterOptions): Promise<RouterResult> {
  const key = apiKey('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');

  const { system, turns } = splitSystem(messages);
  const body = {
    max_tokens: opts.maxTokens ?? 4096,
    ...(system ? { system } : {}),
    messages: turns.map((m) => ({ role: m.role, content: m.content })),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  };

  let lastError: Error | null = null;
  for (const model of claudeModels()) {
    try {
      const res = await fetch(`${providerBaseUrl('ANTHROPIC_API_BASE', 'https://api.anthropic.com')}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': anthropicVersion(),
        },
        body: JSON.stringify({ model, ...body }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`Claude HTTP ${res.status}${await readErrorBody(res)}`);
      const data = (await res.json()) as any;
      const text = String(data?.content?.[0]?.text ?? '').trim();
      if (!text) throw new Error('Claude returned an empty response');
      return { text, provider: 'claude', model };
    } catch (error: any) {
      lastError = error;
      if (!isRetryableModelError(error?.message || '')) break;
    }
  }
  throw lastError ?? new Error('No Claude text model answered');
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

/**
 * Pollinations text: the one provider that needs no key, no GPU and no account.
 *
 * It exists here because the paid providers fail in ways a deployment cannot
 * fix from code — an invalid Gemini key and an exhausted Anthropic balance both
 * answered HTTP 400, and with nothing behind them the whole factory returned
 * 503 while /api/health still said text was available. This is the floor: if a
 * free model can write a mediocre screenplay, the app can still make a film.
 *
 * Quality is honestly lower than Gemini's, which is why it sits after every
 * keyed provider and before local Ollama.
 */
async function callPollinations(messages: ChatMessage[], opts: RouterOptions): Promise<RouterResult> {
  const model = (process.env.POLLINATIONS_TEXT_MODEL || 'openai').trim();
  const { system, turns } = splitSystem(messages);
  const payload = {
    model,
    // Pollinations takes the system turn as a message, like OpenAI does.
    messages: system ? [{ role: 'system', content: system }, ...turns] : turns,
    temperature: opts.temperature ?? 0.7,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
  };

  // The free tier answers one request per 45 seconds per IP and rejects the
  // rest with HTTP 402 FREE_LIMIT plus a "Retry after Ns" hint. A film needs
  // several completions (script, bible, scene breakdown), so treating that as a
  // hard failure would make the free path unusable. Wait the hint out, then
  // retry — bounded, so a real outage still surfaces as an error.
  const maxTries = Number(process.env.POLLINATIONS_TEXT_RETRIES) || 3;
  let lastDetail = '';
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const res = await fetch(`${pollinationsTextUrl()}/openai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
      if (!text) throw new Error('Pollinations returned an empty response');
      return { text, provider: 'pollinations', model: `pollinations/${model}` };
    }

    const detail = await readErrorBody(res);
    lastDetail = `Pollinations HTTP ${res.status}${detail}`;
    const waitMs = rateLimitWaitMs(res.status, detail);
    if (waitMs === null || attempt === maxTries) break;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  throw new Error(lastDetail);
}

/** How long a rate-limited answer asks us to wait, or null when it is not a rate limit. */
function rateLimitWaitMs(status: number, detail: string): number | null {
  if (status !== 402 && status !== 429) return null;
  const match = /retry after (\d+)/i.exec(detail) || /"retry_after"\s*:\s*(\d+)/i.exec(detail);
  const seconds = match ? Number(match[1]) : 45;
  // A hint far beyond a request budget means the limit will not clear in time.
  if (!Number.isFinite(seconds) || seconds > 120) return null;
  return Math.max(1000, seconds * 1000 + 500);
}

function pollinationsTextUrl(): string {
  return (process.env.POLLINATIONS_TEXT_URL || 'https://text.pollinations.ai').trim().replace(/\/$/, '');
}

async function callCloudflare(messages: ChatMessage[], opts: RouterOptions): Promise<RouterResult> {
  const { text, model } = await cloudflareChat(messages, opts);
  return { text, provider: 'cloudflare', model };
}

const CALLERS: Record<TextProvider, (m: ChatMessage[], o: RouterOptions) => Promise<RouterResult>> = {
  cloudflare: callCloudflare,
  gemini: callGemini,
  deepseek: callDeepSeek,
  claude: callClaude,
  pollinations: callPollinations,
  ollama: callOllama,
};

const LABELS: Record<TextProvider, string> = {
  cloudflare: 'Cloudflare AI Gateway',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  claude: 'Claude',
  pollinations: 'Pollinations',
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
