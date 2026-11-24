/**
 * SwarmUI outlet: the radar probe and the movie render, against a real server.
 *
 * SwarmUI speaks JSON over HTTP on port 7801 by default. Three routes matter:
 *
 *   POST /API/GetNewSession         -> { session_id }
 *   POST /API/GetCurrentStatus      -> { status, backend_status, supported_features }
 *   POST /API/GenerateText2Image    -> { images: ["View/local/raw/....png"] }
 *
 * Every call is a POST with a JSON body, and every call except GetNewSession
 * needs the `session_id` inside that body. Generation parameters live flat at
 * the root of the same object, next to `session_id` and `images` — SwarmUI
 * reads the whole body as the parameter map.
 *
 * Nothing here reports success it did not observe: a probe is `reachable` only
 * when GetCurrentStatus answered, and a render returns bytes only when the
 * image route actually served them.
 */

/** Base URL of the SwarmUI server, without a trailing slash. */
export function swarmUrl(): string {
  return (process.env.SWARMUI_URL || 'http://127.0.0.1:7801').replace(/\/+$/, '');
}

/** How long a status probe may take before the server is called unreachable. */
const PROBE_TIMEOUT_MS = 5000;

/** How long one image generation may take before it is abandoned. */
function generateTimeoutMs(): number {
  const n = Number(process.env.SWARMUI_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 300000;
}

/** A session id plus the facts GetNewSession reported about it. */
export interface SwarmSession {
  session_id: string;
  user_id?: string;
  version?: string;
  permissions?: string[];
}

/** The answer to "is SwarmUI alive right now?", with the exact cause when not. */
export interface SwarmReachability {
  reachable: boolean;
  /** The base URL that was probed (SWARMUI_URL). */
  url: string;
  /** Empty when reachable; names the URL that failed when not. */
  error: string;
  /** The underlying cause (timeout, HTTP status, SwarmUI error), when not reachable. */
  detail?: string;
  /** Round-trip time of the probe, when the server answered at all. */
  latency_ms?: number;
  /** SwarmUI's own view of its backends, passed through unchanged. */
  backend_status?: Record<string, unknown>;
  /** How many generations are queued or running, from SwarmUI itself. */
  queue?: Record<string, number>;
  /** Feature ids the backend advertises. */
  supported_features?: string[];
}

/** One POST to SwarmUI. Returns the parsed body, or the failure that stopped it. */
async function swarmPost(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body?: any; error?: string }> {
  try {
    const res = await fetch(`${swarmUrl()}/API/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let parsed: any;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (error: any) {
    const detail = error?.name === 'TimeoutError'
      ? `timeout pagkatapos ng ${timeoutMs}ms`
      : error?.message || String(error);
    return { ok: false, status: 0, error: detail };
  }
}

/** SwarmUI reports a bad request in the body with a 200, so check for `error`. */
function swarmError(body: any): string | null {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.error === 'string') return body.error;
  if (typeof body.error_id === 'string') return body.error_id;
  return null;
}

/** Open a session. SwarmUI creates a guest session when no login is configured. */
export async function swarmSession(timeoutMs = PROBE_TIMEOUT_MS): Promise<SwarmSession> {
  const r = await swarmPost('GetNewSession', {}, timeoutMs);
  if (!r.ok) {
    throw new Error(`SwarmUI GetNewSession returned ${r.status || r.error}`);
  }
  const err = swarmError(r.body);
  if (err) throw new Error(`SwarmUI GetNewSession: ${err}`);
  const id = r.body?.session_id;
  if (!id) throw new Error('SwarmUI did not return a session_id');
  return {
    session_id: String(id),
    user_id: r.body?.user_id,
    version: r.body?.version,
    permissions: Array.isArray(r.body?.permissions) ? r.body.permissions : undefined,
  };
}

/**
 * Probe `{SWARMUI_URL}/API/GetCurrentStatus` through a real session. This is
 * the single place that decides liveness for the radar and the operator:
 * `reachable` is true only when the status call answered without an error, and
 * `error` always names the URL that failed.
 */
export async function checkSwarmReachability(): Promise<SwarmReachability> {
  const url = swarmUrl();
  const unreachable = (detail: string, latency?: number): SwarmReachability => ({
    reachable: false,
    url,
    error: `hindi maabot ang SwarmUI sa ${url}`,
    detail,
    latency_ms: latency,
  });

  const started = Date.now();
  let session: SwarmSession;
  try {
    session = await swarmSession();
  } catch (error: any) {
    return unreachable(error?.message || String(error), Date.now() - started);
  }

  const status = await swarmPost('GetCurrentStatus', { session_id: session.session_id }, PROBE_TIMEOUT_MS);
  const latency = Date.now() - started;
  if (!status.ok) {
    return unreachable(`GetCurrentStatus ${status.status || status.error}`, latency);
  }
  const err = swarmError(status.body);
  if (err) return unreachable(`GetCurrentStatus: ${err}`, latency);

  return {
    reachable: true,
    url,
    error: '',
    latency_ms: latency,
    backend_status: status.body?.backend_status ?? undefined,
    queue: status.body?.status ?? undefined,
    supported_features: Array.isArray(status.body?.supported_features)
      ? status.body.supported_features
      : undefined,
  };
}

/** Parameters for one text-to-image render. All are optional but the prompt. */
export interface SwarmGenerateOptions {
  negative?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  /** A SwarmUI model id, eg `OfficialStableDiffusion/sd_xl_base_1.0`. */
  model?: string;
}

/**
 * Generate one image and return its bytes.
 *
 * SwarmUI answers with file paths, not bytes: the render is fetched with a
 * second GET against the same host. A `data:` URL is already the image.
 */
export async function generateWithSwarm(
  prompt: string,
  opts: SwarmGenerateOptions = {},
): Promise<Buffer> {
  const session = await swarmSession();
  const timeout = generateTimeoutMs();

  // Parameters sit at the root of the body, beside `images` and `session_id`;
  // SwarmUI treats the whole object as the parameter map.
  const body: Record<string, unknown> = {
    session_id: session.session_id,
    images: 1,
    prompt,
    negativeprompt: opts.negative ?? '',
    width: opts.width ?? 1024,
    height: opts.height ?? 1024,
    steps: opts.steps ?? 20,
    cfgscale: opts.cfgScale ?? 7,
    seed: opts.seed ?? -1,
  };
  if (opts.model) body.model = opts.model;

  const queued = await swarmPost('GenerateText2Image', body, timeout);
  if (!queued.ok) {
    throw new Error(`SwarmUI GenerateText2Image returned ${queued.status || queued.error}`);
  }
  const err = swarmError(queued.body);
  if (err) throw new Error(`SwarmUI GenerateText2Image: ${err}`);

  const images = queued.body?.images;
  const path = Array.isArray(images) ? images[0] : undefined;
  if (typeof path !== 'string' || !path) {
    throw new Error('SwarmUI returned no image path');
  }
  return fetchSwarmImage(path);
}

/** Read one image the server produced: a `data:` URL, or a path on the host. */
async function fetchSwarmImage(path: string): Promise<Buffer> {
  if (path.startsWith('data:')) {
    const comma = path.indexOf(',');
    if (comma < 0) throw new Error('SwarmUI returned a malformed data URL');
    return Buffer.from(path.slice(comma + 1), 'base64');
  }
  // SwarmUI serves generated files under /View/, so a returned path like
  // `View/local/raw/x.png` is fetched from the same host.
  const rel = path.replace(/^\/+/, '');
  const url = rel.startsWith('View/') || rel.startsWith('Output/')
    ? `${swarmUrl()}/${rel}`
    : `${swarmUrl()}/View/${rel}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`SwarmUI image route returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Is a SwarmUI server reachable right now? Cheap enough for a poll. */
export async function swarmAvailable(): Promise<boolean> {
  try {
    return (await checkSwarmReachability()).reachable;
  } catch {
    return false;
  }
}

/** True when a SwarmUI URL is configured, so the radar can tell "off" from "down". */
export function swarmConfigured(): boolean {
  return Boolean(process.env.SWARMUI_URL && process.env.SWARMUI_URL.trim());
}
