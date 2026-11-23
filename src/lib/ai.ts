/**
 * Cloudflare AI Gateway transport.
 *
 * This is one provider, not a router. `aiRouter.ts` decides whether to call it;
 * this module only knows how to reach the gateway and how to fail honestly.
 *
 * Two routes are supported:
 *   - `dynamic/movie-creator-brain` — a gateway-side dynamic route that picks the
 *     model for us. It is opt-in on the Cloudflare side, so a 404 here means the
 *     route is not configured, not that the request was malformed.
 *   - `@cf/qwen/qwen2.5-coder-32b-instruct` — a concrete Workers AI model, used
 *     only when explicitly requested.
 *
 * When the dynamic route 404s we stop asking for the rest of the process. That
 * is the circuit breaker: a misconfigured gateway must cost one failed request,
 * not one per chat turn.
 */

import { sanitizeError } from './secrets.ts';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CloudflareOptions {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Override the model for one call. Defaults to the dynamic route. */
  model?: string;
}

export interface CloudflareResult {
  text: string;
  model: string;
}

/** Raised for anything the gateway could not answer. Never holds a token. */
export class CloudflareGatewayError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(message: string, code: string, status: number | null = null) {
    super(sanitizeError(message));
    this.name = 'CloudflareGatewayError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Process-lifetime breaker for the dynamic route.
 *
 * A 404 on `dynamic/movie-creator-brain` means the route does not exist on the
 * gateway. Retrying it on every turn would add a failed round-trip to every
 * reply, so once we see it we stay off that route until the process restarts.
 */
let dynamicRouteUnavailable = false;

/** True once the dynamic route has returned 404 in this process. */
export function isDynamicRouteUnavailable(): boolean {
  return dynamicRouteUnavailable;
}

/** Test seam: forget a breaker trip. */
export function resetCloudflareCircuitBreaker(): void {
  dynamicRouteUnavailable = false;
}

export const DYNAMIC_MODEL = 'dynamic/movie-creator-brain';
export const QWEN_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';

function accountId(): string {
  return (process.env.CF_ACCOUNT_ID || '').trim();
}

function apiToken(): string {
  return (process.env.CF_API_TOKEN || '').trim();
}

function gatewayId(): string {
  return (process.env.AI_GATEWAY_ID || 'movie-creator').trim() || 'movie-creator';
}

/**
 * Cloudflare needs both an account id and a token. The gateway id has a default,
 * so it never blocks a call.
 */
export function cloudflareConfigured(): boolean {
  return Boolean(accountId() && apiToken());
}

/**
 * The default model for a call.
 *
 * When the dynamic route has already 404'd we drop straight to the concrete
 * Workers AI model, which needs no gateway-side configuration.
 */
export function defaultCloudflareModel(): string {
  return dynamicRouteUnavailable ? QWEN_MODEL : DYNAMIC_MODEL;
}

function endpoint(): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId())}/ai/v1/chat/completions`;
}

/**
 * Ask the gateway for one completion.
 *
 * Throws `CloudflareGatewayError` with `code: 'NOT_CONFIGURED'` when the env is
 * incomplete, so the router can tell "not set up" apart from "tried and failed".
 */
export async function cloudflareChat(
  messages: ChatMessage[],
  opts: CloudflareOptions = {},
): Promise<CloudflareResult> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new CloudflareGatewayError('cloudflareChat needs at least one message', 'BAD_REQUEST');
  }
  if (!cloudflareConfigured()) {
    throw new CloudflareGatewayError(
      'CF_ACCOUNT_ID and CF_API_TOKEN are not both set',
      'NOT_CONFIGURED',
    );
  }

  const model = (opts.model || defaultCloudflareModel()).trim();

  let res: Response;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken()}`,
        'cf-aig-gateway-id': gatewayId(),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2048,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (error: any) {
    // A network failure is not a configuration verdict, so it does not trip the
    // breaker: the route may be fine and the network merely down.
    throw new CloudflareGatewayError(
      `hindi maabot ang Cloudflare AI Gateway (${error?.message || 'fetch failed'})`,
      'NETWORK',
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = body ? `: ${sanitizeError(body).slice(0, 300)}` : '';

    // Only the dynamic route is trip-worthy, and only on a real 404. A 404 for
    // the concrete model would mean the model name is wrong, not the route.
    if (res.status === 404 && model === DYNAMIC_MODEL) {
      dynamicRouteUnavailable = true;
      throw new CloudflareGatewayError(
        `dynamic route '${DYNAMIC_MODEL}' ay wala sa gateway (404)${detail}`,
        'DYNAMIC_ROUTE_MISSING',
        404,
      );
    }

    const code = res.status === 401 || res.status === 403 ? 'AUTH' : `HTTP_${res.status}`;
    throw new CloudflareGatewayError(`Cloudflare HTTP ${res.status}${detail}`, code, res.status);
  }

  const data = (await res.json()) as any;
  const text = String(data?.choices?.[0]?.message?.content ?? data?.result?.response ?? '').trim();
  if (!text) {
    throw new CloudflareGatewayError('Cloudflare returned an empty response', 'EMPTY', res.status);
  }
  return { text, model: String(data?.model || model) };
}

/** The models this module would try, in order, for a status report. */
export function cloudflareModelPlan(): string[] {
  return dynamicRouteUnavailable ? [QWEN_MODEL] : [DYNAMIC_MODEL, QWEN_MODEL];
}
