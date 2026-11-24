/**
 * Test-only stand-in for the SwarmUI HTTP API.
 *
 * It answers the same routes the real server does, in the same wire format:
 * every call is a POST with a JSON body, `session_id` travels inside that body,
 * and generation parameters sit flat at the root beside `images`. That shape is
 * the whole point of the mock — a client that nests its parameters under
 * `rawInput` or sends them as form data fails here, exactly as it would fail
 * against the real server.
 *
 * Nothing here is imported by the app itself.
 */

import http from 'node:http';

/** A real 1x1 PNG, so the image path serves actual decodable bytes. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

export interface MockSwarmOptions {
  /** Reported in `backend_status`; the real server sends "running", "idle", ... */
  backendState?: string;
  /** Make GetCurrentStatus fail with this SwarmUI error string. */
  statusError?: string;
  /** Make GenerateText2Image fail with this SwarmUI error string. */
  generateError?: string;
  /** Return a `data:` URL instead of a host path. */
  inlineImage?: boolean;
}

export interface MockSwarm {
  url: string;
  close: () => Promise<void>;
  /** Every body the mock received, in order, for wire-format assertions. */
  received: () => Array<{ path: string; body: any }>;
  /** How many times each route was hit. */
  hits: (path: string) => number;
}

export function startMockSwarmUI(opts: MockSwarmOptions = {}): Promise<MockSwarm> {
  const backendState = opts.backendState ?? 'running';
  const log: Array<{ path: string; body: any }> = [];
  const counts: Record<string, number> = {};
  let sessions = 0;

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (body: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };

    // The generated image is served by a plain GET, not an API route.
    if (url.startsWith('/View/') && req.method === 'GET') {
      counts['/View/'] = (counts['/View/'] ?? 0) + 1;
      res.setHeader('Content-Type', 'image/png');
      res.end(TINY_PNG);
      return;
    }

    if (req.method !== 'POST' || !url.startsWith('/API/')) {
      res.statusCode = 404;
      json({ error: 'Unknown API route.', error_id: 'bad_route' });
      return;
    }

    const route = url.slice('/API/'.length).toLowerCase();
    counts[route] = (counts[route] ?? 0) + 1;

    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = null; }
      log.push({ path: route, body });

      if (route === 'getnewsession') {
        sessions += 1;
        json({
          session_id: `session-${sessions}`,
          user_id: 'local',
          version: '0.9.5-test',
          permissions: ['basic_image_generation', 'fundamental_generate_tab_access'],
        });
        return;
      }

      // Every other route needs a session id, sent in the body. The real server
      // also accepts an X-Session-ID header, but the body is what we rely on.
      if (!body || typeof body.session_id !== 'string' || !body.session_id) {
        res.statusCode = 401;
        json({ error: 'Request input lacks required session id', error_id: 'invalid_session_id' });
        return;
      }

      if (route === 'getcurrentstatus') {
        if (opts.statusError) {
          json({ error: opts.statusError });
          return;
        }
        json({
          status: { waiting_gens: 0, loading_models: 0, waiting_backends: 0, live_gens: 0 },
          backend_status: { status: backendState, class: '', message: '', any_loading: false },
          supported_features: ['param_seed', 'param_steps'],
        });
        return;
      }

      if (route === 'generatetext2image') {
        if (opts.generateError) {
          json({ error: opts.generateError });
          return;
        }
        if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
          // The real server rejects a request with no prompt parameter.
          json({ error: 'Missing required parameter: prompt' });
          return;
        }
        const image = opts.inlineImage
          ? `data:image/png;base64,${TINY_PNG.toString('base64')}`
          : 'View/local/raw/2026-01-01/0101-a prompt-1.png';
        json({ images: [image] });
        return;
      }

      res.statusCode = 404;
      json({ error: 'Unknown API route.', error_id: 'bad_route' });
    });
  });

  return new Promise<MockSwarm>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
        received: () => log,
        hits: (path: string) => counts[path.toLowerCase()] ?? 0,
      });
    });
  });
}

/** Run `fn` with SWARMUI_URL pointed at the mock, then restore the environment. */
export async function withMockSwarmUI<T>(
  fn: (mock: MockSwarm) => Promise<T>,
  opts: MockSwarmOptions = {},
): Promise<T> {
  const mock = await startMockSwarmUI(opts);
  const saved = process.env.SWARMUI_URL;
  process.env.SWARMUI_URL = mock.url;
  try {
    return await fn(mock);
  } finally {
    if (saved === undefined) delete process.env.SWARMUI_URL;
    else process.env.SWARMUI_URL = saved;
    await mock.close();
  }
}
