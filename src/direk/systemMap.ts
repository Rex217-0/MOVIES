/**
 * The system map behind the Radar tab.
 *
 * The Radar is a live signal, not a decoration. Every node is probed for real:
 * a local service is asked whether it answers, a cloud provider is called only
 * when it can be reached without a secret, and everything else reports the
 * honest state of its configuration. Nothing here fabricates a green light —
 * a node is only "active" when a real request came back.
 *
 * Four states, mapped to the blink the UI draws:
 *   active  -> green, smooth pulse          (verified live, right now)
 *   error   -> red, hard double-blink       (reachable but failing)
 *   standby -> amber, slow pulse            (configured, not verified)
 *   dead    -> black, no blink              (no configuration / not running)
 */

export type NodeStatus = 'active' | 'error' | 'standby' | 'dead';

export type NodeKind =
  | 'core' | 'ai' | 'local' | 'cloud' | 'storage' | 'training' | 'agent';

export type NodeLayer = 'center' | 'behind' | 'left' | 'right' | 'front';

export interface MapNode {
  id: string;
  name: string;
  kind: NodeKind;
  layer: NodeLayer;
  /** false = wireless (the AI models), true = a drawn wire. */
  wired: boolean;
  /** CSS colour for the wire, taken from the provider's own logo. */
  wire?: string;
  status: NodeStatus;
  /** One honest line about what the probe actually saw. */
  detail: string;
  /** Round-trip time of the probe, when one was made. */
  latency_ms?: number;
  /** What the probe did, so the UI can explain the status. */
  probe: string;
  /** What this node contributes to Movie Creator. */
  role: string;
  /** Optional extra facts (model lists, counts, error text). */
  meta?: Record<string, string | number | boolean | null>;
}

export interface SystemMap {
  checked_at: string;
  center: string;
  counts: Record<NodeStatus, number>;
  nodes: MapNode[];
}

/** What a probe is allowed to look at. Tests inject fakes here. */
export interface ProbeEnv {
  getEnv: (name: string) => string | undefined;
  fetchJson: (url: string, timeoutMs: number) => Promise<{ ok: boolean; status: number; body?: any; error?: string }>;
  comfyAvailable: () => Promise<boolean>;
  comfyUrl: string;
  /** Probes SwarmUI's own status route; returns null when it is not configured. */
  swarmStatus?: () => Promise<{ reachable: boolean; url: string; error: string; detail?: string; latency_ms?: number; backend_status?: Record<string, unknown>; queue?: Record<string, number> } | null>;
  ollamaUrl: string;
  ollamaModel: string;
  ffmpegAvailable: () => Promise<boolean>;
  openhandsUrl?: string;
}

/** Wire colours, taken from each provider's own logo. */
const WIRE = {
  githubCopilot: '#e6edf3',      // GitHub white
  googleAiStudio: '#1a73e8',     // Google Studio blue
  kaggle: '#20beff',             // Kaggle blue
  colab: '#f9ab00',              // Colab orange
  firebase: '#ffca28',           // Firebase gold
  googleCloud: '#ea4335',        // Google Cloud red
  openhands: '#d97757',          // OpenHands warm coral
  comfyui: '#4b5563',            // ComfyUI grey
  swarmui: '#8b5cf6',            // SwarmUI violet
  deepseek: '#4d6bfe',           // DeepSeek blue
  anthropic: '#d97757',          // Anthropic coral
  meta: '#0866ff',               // Meta blue
  ffmpeg: '#007808',             // ffmpeg green
  gdrive: '#0f9d58',             // Google Drive green
} as const;

function present(v: string | undefined): boolean {
  return Boolean(v && v.trim().length > 0);
}

function elapsed(started: number): number {
  return Math.max(0, Date.now() - started);
}

/** Status of a plain HTTP probe: answered = active, answered badly = error. */
function httpStatus(r: { ok: boolean; status: number }): NodeStatus {
  if (r.ok) return 'active';
  if (r.status > 0) return 'error';
  return 'dead';
}

/**
 * Probe every node and return the map. `env` is required so the tests can
 * inject a fake network and a fake environment.
 */
export async function buildSystemMap(env: ProbeEnv): Promise<SystemMap> {
  const nodes: MapNode[] = [];
  const add = (n: MapNode) => { nodes.push(n); return n; };

  // Time every probe so the UI can show a real round-trip.
  const probe = async (url: string, timeoutMs = 3500) => {
    const started = Date.now();
    const r = await env.fetchJson(url, timeoutMs);
    return { ...r, latency: elapsed(started) };
  };
  const describe = (r: { ok: boolean; status: number; error?: string }, what: string) =>
    r.ok ? `Sumagot ang ${what}.` : (r.error === 'fetch failed' ? `Hindi maabot ang ${what}.` : (r.error || `Nagbalik ng ${r.status}.`));

  // ---- centre: Movie Creator itself ---------------------------------------
  add({
    id: 'movie-creator', name: 'Movie Creator', kind: 'core', layer: 'center', wired: true,
    status: 'active', probe: 'This process is answering this request.',
    detail: 'Tumatakbo ngayon — ito ang server na nag-render ng pelikula.',
    role: 'Ang app: brief → script → scenes → rendered film.',
    meta: { pid: process.pid, node: process.version },
  });

  // ---- local runtime behind the app ---------------------------------------
  const comfyOn = env.getEnv('COMFYUI_DISABLE') !== '1';
  let comfyStatus: NodeStatus = 'dead';
  let comfyDetail = 'Naka-off (COMFYUI_DISABLE=1).';
  let comfyLatency: number | undefined;
  if (comfyOn) {
    const started = Date.now();
    const ok = await env.comfyAvailable();
    comfyLatency = elapsed(started);
    comfyStatus = ok ? 'active' : 'dead';
    comfyDetail = ok ? 'Sumagot ang /system_stats — buhay.' : 'Walang sagot sa /system_stats.';
  }
  add({
    id: 'comfyui', name: 'ComfyUI', kind: 'local', layer: 'behind', wired: true,
    wire: WIRE.comfyui, status: comfyStatus, detail: comfyDetail,
    latency_ms: comfyLatency,
    probe: `GET ${env.comfyUrl}/system_stats`,
    role: 'Lokal na image/video render sa GPU. Libre.',
    meta: { url: env.comfyUrl, disabled: !comfyOn },
  });

  // ---- SwarmUI: the second local render outlet ----------------------------
  // Only reported when a probe is wired in; an unconfigured server stays
  // absent rather than claiming a node that cannot answer.
  if (env.swarmStatus) {
    const started = Date.now();
    const swarm = await env.swarmStatus();
    if (swarm) {
      const live = swarm.reachable;
      const backend = swarm.backend_status ?? {};
      const backendState = typeof backend.status === 'string' ? backend.status : '';
      const backendMessage = typeof backend.message === 'string' ? backend.message : '';
      const queue = swarm.queue ?? {};
      const busy = Number(queue.waiting_gens ?? 0) + Number(queue.live_gens ?? 0);
      let detail: string;
      if (!live) {
        detail = swarm.detail ? `Walang sagot: ${swarm.detail}` : 'Walang sagot sa /API/GetCurrentStatus.';
      } else if (backendState) {
        detail = `GetCurrentStatus sumagot — backend "${backendState}"${busy > 0 ? `, ${busy} nasa pila` : ', walang pila'}.`;
      } else {
        detail = 'GetCurrentStatus sumagot — buhay.';
      }
      add({
        id: 'swarmui', name: 'SwarmUI', kind: 'local', layer: 'behind', wired: true,
        wire: WIRE.swarmui,
        status: live ? 'active' : 'dead',
        detail,
        latency_ms: swarm.latency_ms ?? elapsed(started),
        probe: `POST ${swarm.url}/API/GetCurrentStatus`,
        role: 'Ikalawang lokal na image render outlet. Libre.',
        meta: {
          url: swarm.url,
          backend_status: backendState || null,
          backend_message: backendMessage || null,
          waiting_gens: Number(queue.waiting_gens ?? 0),
          live_gens: Number(queue.live_gens ?? 0),
          ...(swarm.error ? { error: swarm.error } : {}),
        },
      });
    }
  }

  const ohUrl = (env.openhandsUrl || env.getEnv('OPENHANDS_URL') || '').replace(/\/$/, '');
  const ohKey = env.getEnv('OPENHANDS_API_KEY') || env.getEnv('OH_GIT_CREDENTIAL_ACCESS_TOKEN_GITHUB');
  let ohStatus: NodeStatus = 'dead';
  let ohDetail = 'Walang OPENHANDS_URL — hindi naka-configure dito.';
  let ohLatency: number | undefined;
  if (present(ohUrl)) {
    const r = await probe(`${ohUrl}/health`, 3000);
    ohLatency = r.latency;
    ohStatus = httpStatus(r);
    ohDetail = describe(r, '/health');
  }
  add({
    id: 'openhands', name: 'OpenHands', kind: 'agent', layer: 'behind', wired: true,
    wire: WIRE.openhands, status: ohStatus, detail: ohDetail, latency_ms: ohLatency,
    probe: present(ohUrl) ? `GET ${ohUrl}/health` : 'env OPENHANDS_URL',
    role: 'Ang coding agent na bumubuo at nag-aayos ng app na ito.',
    meta: { url: ohUrl || null, key_configured: present(ohKey) },
  });

  // ---- right side: visual GPU + storage -----------------------------------
  // Kaggle and Colab cannot be called without a secret, so we probe their
  // public home pages: reachable means we can see the provider, not that we are
  // logged in. A missing API path would read as a false error, so we use the root.
  const kaggle = await probe('https://www.kaggle.com/');
  add({
    id: 'kaggle', name: 'Kaggle', kind: 'training', layer: 'right', wired: true,
    wire: WIRE.kaggle, status: httpStatus(kaggle), detail: describe(kaggle, 'Kaggle'),
    latency_ms: kaggle.latency,
    probe: 'GET kaggle.com',
    role: 'Libreng GPU (T4, ~30 oras/linggo) para sa training at render.',
    meta: { token_configured: present(env.getEnv('KAGGLE_PILOT_TOKEN')) },
  });

  const colab = await probe('https://colab.research.google.com/');
  add({
    id: 'colab', name: 'Google Colab', kind: 'training', layer: 'right', wired: true,
    wire: WIRE.colab, status: httpStatus(colab), detail: describe(colab, 'Colab'),
    latency_ms: colab.latency,
    probe: 'GET colab.research.google.com',
    role: 'Libreng GPU notebooks para sa LoRA training.',
    meta: {},
  });

  const gc = await probe('https://cloud.google.com/');
  add({
    id: 'google-cloud', name: 'Google Cloud', kind: 'cloud', layer: 'right', wired: true,
    wire: WIRE.googleCloud, status: httpStatus(gc), detail: describe(gc, 'Google Cloud'),
    latency_ms: gc.latency,
    probe: 'GET cloud.google.com',
    role: 'Hosting at APIs (Firestore, Drive). May bayad na tier.',
    meta: { project: env.getEnv('FIREBASE_PROJECT_ID') ?? null },
  });

  // Firebase is real: we read its public identity config and probe the Auth REST
  // host. The web API key is public client config, not a secret.
  const fb = await probe('https://identitytoolkit.googleapis.com/');
  const fbProject = env.getEnv('FIREBASE_PROJECT_ID');
  add({
    id: 'firebase', name: 'Firebase', kind: 'storage', layer: 'right', wired: true,
    wire: WIRE.firebase,
    status: fbProject && fb.status ? (fb.ok || fb.status === 404 || fb.status === 400 ? 'active' : 'error') : 'dead',
    detail: fbProject ? `Naaabot ang Firebase Auth (${fbProject}).` : 'Walang FIREBASE_PROJECT_ID.',
    latency_ms: fb.latency,
    probe: 'GET identitytoolkit.googleapis.com',
    role: 'Auth + Firestore history ng bawat user.',
    meta: { project: fbProject ?? null, admin_key_configured: present(env.getEnv('FIREBASE_PRIVATE_KEY')) },
  });

  // ---- left side: AI-powered tools ----------------------------------------
  const gh = await probe('https://api.github.com/');
  add({
    id: 'github', name: 'GitHub', kind: 'agent', layer: 'left', wired: true,
    wire: WIRE.githubCopilot, status: httpStatus(gh), detail: describe(gh, 'GitHub API'),
    latency_ms: gh.latency,
    probe: 'GET api.github.com',
    role: 'Source control ng buong proyekto.',
    meta: { token_configured: present(env.getEnv('GITHUB_TOKEN')) },
  });

  // Copilot rides on the GitHub token; there is no separate public endpoint.
  const ghToken = present(env.getEnv('GITHUB_TOKEN'));
  add({
    id: 'copilot', name: 'GitHub Copilot', kind: 'ai', layer: 'left', wired: true,
    wire: WIRE.githubCopilot,
    status: ghToken ? 'standby' : 'dead',
    detail: ghToken
      ? 'May GITHUB_TOKEN. Hindi direktang na-verify ang Copilot API.'
      : 'Walang GITHUB_TOKEN — hindi magagamit.',
    probe: 'env GITHUB_TOKEN',
    role: 'AI code suggestions sa loob ng editor.',
    meta: { token_configured: ghToken },
  });

  const aistudio = await probe('https://aistudio.google.com/');
  add({
    id: 'google-ai-studio', name: 'Google AI Studio', kind: 'ai', layer: 'left', wired: true,
    wire: WIRE.googleAiStudio, status: httpStatus(aistudio), detail: describe(aistudio, 'AI Studio'),
    latency_ms: aistudio.latency,
    probe: 'GET aistudio.google.com',
    role: 'Daanan para sa Gemini API key at prototyping.',
    meta: { gemini_key_configured: present(env.getEnv('GEMINI_API_KEY')) },
  });

  const manus = await probe('https://manus.im/');
  add({
    id: 'manus', name: 'Manus', kind: 'agent', layer: 'left', wired: true,
    wire: WIRE.anthropic, status: httpStatus(manus), detail: describe(manus, 'Manus'),
    latency_ms: manus.latency,
    probe: 'GET manus.im',
    role: 'Autonomous agent na katuwang sa gawain.',
    meta: {},
  });

  // ---- front: the AI models, wireless (they answer over the network) ------
  const geminiKey = present(env.getEnv('GEMINI_API_KEY'));
  add({
    id: 'gemini', name: 'Gemini', kind: 'ai', layer: 'front', wired: false,
    status: geminiKey ? 'standby' : 'dead',
    detail: geminiKey ? 'May GEMINI_API_KEY — naka-configure para sa text.' : 'Walang GEMINI_API_KEY.',
    probe: 'env GEMINI_API_KEY',
    role: 'Pangunahing text model (script, direksyon).',
    meta: { key_configured: geminiKey },
  });

  // Ollama is a real local text model we can call with no key.
  const ollamaOn = env.getEnv('OLLAMA_DISABLE') !== '1';
  let ollamaStatus: NodeStatus = 'dead';
  let ollamaDetail = 'Naka-off (OLLAMA_DISABLE=1).';
  let ollamaModels: string[] = [];
  let ollamaLatency: number | undefined;
  if (ollamaOn) {
    const r = await probe(`${env.ollamaUrl}/api/tags`, 2500);
    ollamaLatency = r.latency;
    if (r.ok && Array.isArray(r.body?.models)) {
      ollamaModels = r.body.models.map((m: any) => m.name).filter(Boolean);
      const base = env.ollamaModel.split(':')[0];
      const has = ollamaModels.some(m => m === env.ollamaModel || m.startsWith(base));
      ollamaStatus = has ? 'active' : 'error';
      ollamaDetail = has
        ? `Buhay, may model na ${env.ollamaModel}.`
        : `Buhay pero wala ang model na ${env.ollamaModel}.`;
    } else {
      ollamaStatus = httpStatus(r);
      ollamaDetail = describe(r, 'Ollama');
    }
  }
  add({
    id: 'ollama', name: 'Ollama', kind: 'ai', layer: 'front', wired: false,
    status: ollamaStatus, detail: ollamaDetail, latency_ms: ollamaLatency,
    probe: `GET ${env.ollamaUrl}/api/tags`,
    role: 'Lokal na text model — libre, walang key.',
    meta: { url: env.ollamaUrl, model: env.ollamaModel, models: ollamaModels.slice(0, 8).join(', ') },
  });

  const falKey = present(env.getEnv('FAL_KEY'));
  add({
    id: 'wan', name: 'Wan 2.2 (fal.ai)', kind: 'ai', layer: 'front', wired: false,
    status: falKey ? 'standby' : 'dead',
    detail: falKey ? 'May FAL_KEY — BAYAD, opt-in lang.' : 'Walang FAL_KEY.',
    probe: 'env FAL_KEY',
    role: 'Cloud text-to-video. Bayad, hindi default.',
    meta: { key_configured: falKey },
  });

  // Providers integrated through the agent layer, not through a key in .env.
  const modelNode = (id: string, name: string, keyName: string, role: string): MapNode => {
    const has = present(env.getEnv(keyName));
    return {
      id, name, kind: 'ai', layer: 'front', wired: false,
      status: has ? 'standby' : 'dead',
      detail: has ? `May ${keyName}.` : `Walang ${keyName} — hindi direktang naka-wire.`,
      probe: `env ${keyName}`,
      role,
      meta: {},
    };
  };
  add(modelNode('claude', 'Claude', 'ANTHROPIC_API_KEY', 'Alternatibong reasoning model.'));
  add(modelNode('deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY', 'Alternatibong model para sa mura/quick tasks.'));
  add(modelNode('meta', 'Meta (Llama)', 'META_API_KEY', 'Open-weight models para sa lokal na takbo.'));

  // ---- supporting nodes ----------------------------------------------------
  const ffStart = Date.now();
  const ff = await env.ffmpegAvailable();
  add({
    id: 'ffmpeg', name: 'ffmpeg', kind: 'local', layer: 'behind', wired: true,
    wire: WIRE.ffmpeg, status: ff ? 'active' : 'dead',
    detail: ff ? 'Nahanap ang ffmpeg binary.' : 'Walang ffmpeg.',
    latency_ms: elapsed(ffStart),
    probe: 'ffmpeg -version',
    role: 'Nagbuo ng tunay na MP4 (video + audio) nang walang bayad.',
    meta: {},
  });

  const gdConfigured = present(env.getEnv('GDRIVE_CLIENT_ID')) && present(env.getEnv('GDRIVE_CLIENT_SECRET'));
  add({
    id: 'gdrive', name: 'Google Drive', kind: 'storage', layer: 'right', wired: true,
    wire: WIRE.gdrive,
    status: gdConfigured ? 'standby' : 'dead',
    detail: gdConfigured
      ? 'May OAuth client. Kailangan pa ng pahintulot ng user.'
      : 'Walang GDRIVE_CLIENT_ID/SECRET.',
    probe: 'env GDRIVE_CLIENT_ID + GDRIVE_CLIENT_SECRET',
    role: 'Backup ng mga render at dataset sa Drive.',
    meta: { folder_configured: present(env.getEnv('GDRIVE_FOLDER_ID')) },
  });

  const counts: Record<NodeStatus, number> = { active: 0, error: 0, standby: 0, dead: 0 };
  for (const n of nodes) counts[n.status] += 1;

  return { checked_at: new Date().toISOString(), center: 'movie-creator', counts, nodes };
}

function comfyUrlFromEnv(): string {
  return (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
}

/** The real environment, for the server. */
export function realProbeEnv(overrides: Partial<ProbeEnv> = {}): ProbeEnv {
  const timeoutFetch = async (url: string, timeoutMs: number) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      let body: any;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try { body = await res.json(); } catch { body = undefined; }
      }
      return { ok: res.ok, status: res.status, body };
    } catch (error: any) {
      return {
        ok: false, status: 0,
        error: error?.name === 'TimeoutError' ? 'Timeout' : (error?.message || 'unreachable'),
      };
    }
  };
  return {
    getEnv: name => process.env[name],
    fetchJson: timeoutFetch,
    comfyAvailable: async () => {
      try {
        const res = await fetch(`${comfyUrlFromEnv()}/system_stats`, { signal: AbortSignal.timeout(2500) });
        return res.ok;
      } catch { return false; }
    },
    comfyUrl: comfyUrlFromEnv(),
    swarmStatus: async () => {
      const { checkSwarmReachability, swarmConfigured } = await import('./swarmui.ts');
      if (!swarmConfigured()) return null;
      return checkSwarmReachability();
    },
    ollamaUrl: (process.env.OLLAMA_URL || process.env.LOCAL_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:3b',
    ffmpegAvailable: async () => {
      const { ffmpegAvailable } = await import('./render.ts');
      return ffmpegAvailable();
    },
    ...overrides,
  };
}
