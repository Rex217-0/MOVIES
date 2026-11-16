/**
 * The GPU worker mesh (Blocker A).
 *
 * This is the registry and scheduler behind the promise that heavy work runs on
 * the GPUs of other connected machines. A machine that wants to contribute runs
 * a worker and registers itself here with its capabilities (GPU, VRAM, engines).
 * The coordinator then places a job on a worker that advertises the engine the
 * job needs and has a free slot.
 *
 * The registry is in-process and the placements are a pure function of the
 * registered state, so the scheduler is unit-testable without any network. The
 * `dispatchJob` helper is the one place that actually talks to a worker over
 * HTTP.
 *
 * Trust note: a worker is assumed untrusted. It is only ever handed a job, and
 * its output must be verified by the caller (see docs/android-remote-v2-plan.md,
 * risk H). This module does placement, not verification.
 */

export type WorkerStatus = 'idle' | 'busy' | 'offline';

/**
 * What kind of machine a worker is (Blocker G). A phone can contribute a little
 * CPU but cannot run ComfyUI/SDXL, so it is a remote first and a worker only as
 * a clearly-limited low-tier contributor. The scheduler refuses to place heavy
 * work on a `phone` node even if it asks for it.
 */
export type WorkerRole = 'gpu' | 'cpu' | 'phone';

/** Engines that mean heavy GPU work: a phone must never be handed one. */
const HEAVY_ENGINES = new Set(['comfyui', 'sdxl', 'sd', 'lora', 'wan', 'diffusion', 'video_render', 'feature_render']);

export function isHeavyEngine(engine: string): boolean {
  return HEAVY_ENGINES.has(engine.toLowerCase());
}

/** May a worker of this role run this engine? Phones are CPU-tier only. */
export function roleCanRun(role: WorkerRole, engine: string): boolean {
  if (role !== 'phone') return true;
  return !isHeavyEngine(engine);
}

/** What a worker can do. Empty engines means "anything" (a plain CPU node). */
export interface WorkerCapabilities {
  gpu?: string;
  vram_gb?: number;
  engines?: string[];
  models?: string[];
}

export interface WorkerRegistration {
  /** Stable id chosen by the worker (e.g. its hostname). Re-registering updates. */
  id: string;
  label?: string;
  /** Base URL the coordinator calls back, e.g. http://10.0.0.5:8090 */
  url: string;
  /** Per-worker bearer token the coordinator must present. */
  token?: string;
  capabilities?: WorkerCapabilities;
  /** Machine class. Defaults to 'gpu' when it advertises a GPU, else 'cpu'. */
  role?: WorkerRole;
  /** How many jobs the worker will run at once. Defaults to 1. */
  maxConcurrent?: number;
}

export interface WorkerRecord {
  id: string;
  label: string;
  url: string;
  token?: string;
  capabilities: WorkerCapabilities;
  role: WorkerRole;
  maxConcurrent: number;
  status: WorkerStatus;
  /** Slots currently taken. */
  active: number;
  registeredAt: number;
  lastHeartbeat: number;
  completed: number;
  failed: number;
}

/** The public view of a worker: never exposes the token. */
export type WorkerView = Omit<WorkerRecord, 'token'>;

const DEFAULT_HEARTBEAT_TTL_MS = 90_000;

export interface WorkerMeshOptions {
  /** A worker is offline when its last heartbeat is older than this. */
  ttlMs?: number;
}

export class WorkerMesh {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly ttlMs: number;
  private roundRobin = 0;

  constructor(options: WorkerMeshOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  }

  /** Register a worker, or refresh an existing one (re-registering is a heartbeat). */
  register(reg: WorkerRegistration, now = Date.now()): WorkerRecord {
    const id = (reg.id || '').trim();
    if (!id) throw new Error('Kailangan ng worker id.');
    if (!reg.url || !/^https?:\/\//i.test(reg.url)) {
      throw new Error(`Worker ${id}: kailangan ng http(s) URL.`);
    }
    const existing = this.workers.get(id);
    const maxConcurrent = Math.max(1, Math.floor(reg.maxConcurrent ?? existing?.maxConcurrent ?? 1));
    const capabilities = reg.capabilities ?? existing?.capabilities ?? {};
    // A node that calls itself a phone is never allowed to grow into a GPU node.
    const role: WorkerRole = reg.role ?? existing?.role ?? (capabilities.gpu ? 'gpu' : 'cpu');
    const record: WorkerRecord = {
      id,
      label: reg.label?.trim() || existing?.label || id,
      url: reg.url.replace(/\/+$/, ''),
      token: reg.token ?? existing?.token,
      capabilities,
      role,
      maxConcurrent,
      status: existing && existing.active > 0 ? 'busy' : 'idle',
      active: existing?.active ?? 0,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeat: now,
      completed: existing?.completed ?? 0,
      failed: existing?.failed ?? 0,
    };
    this.workers.set(id, record);
    return record;
  }

  heartbeat(id: string, now = Date.now()): WorkerRecord | undefined {
    const worker = this.workers.get(id);
    if (!worker) return undefined;
    worker.lastHeartbeat = now;
    this.refreshStatus(worker, now);
    return worker;
  }

  deregister(id: string): boolean {
    return this.workers.delete(id);
  }

  /** Every known worker, with stale ones marked offline. */
  list(now = Date.now()): WorkerRecord[] {
    this.sweep(now);
    return [...this.workers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Workers that are online (idle or busy). */
  online(now = Date.now()): WorkerRecord[] {
    return this.list(now).filter(w => w.status !== 'offline');
  }

  /**
   * Pick a worker for a job that needs `engine`. Only online workers that
   * advertise the engine and have a free slot are eligible. Among them, the
   * least-busy worker wins; ties break oldest-heartbeat-first, then round-robin,
   * so load spreads instead of hammering one box.
   */
  select(engine: string, now = Date.now()): WorkerRecord | null {
    const eligible = this.online(now).filter(
      w => w.active < w.maxConcurrent && advertises(w, engine) && roleCanRun(w.role, engine),
    );
    if (!eligible.length) return null;
    eligible.sort((a, b) => {
      if (a.active !== b.active) return a.active - b.active;
      if (a.lastHeartbeat !== b.lastHeartbeat) return a.lastHeartbeat - b.lastHeartbeat;
      return a.id.localeCompare(b.id);
    });
    // Nudge the round-robin pointer so identical workers alternate fairly.
    this.roundRobin = (this.roundRobin + 1) % Math.max(1, eligible.length);
    return eligible[this.roundRobin % eligible.length] ?? eligible[0];
  }

  /** Take a slot on a worker. Returns false when it is full or offline. */
  acquire(id: string, now = Date.now()): boolean {
    const worker = this.workers.get(id);
    if (!worker) return false;
    this.refreshStatus(worker, now);
    if (worker.status === 'offline' || worker.active >= worker.maxConcurrent) return false;
    worker.active += 1;
    worker.status = 'busy';
    return true;
  }

  /** Release a slot after a job finishes, recording success or failure. */
  release(id: string, ok: boolean, now = Date.now()): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.active = Math.max(0, worker.active - 1);
    if (ok) worker.completed += 1;
    else worker.failed += 1;
    this.refreshStatus(worker, now);
  }

  /** A short summary for the status endpoint. */
  summary(now = Date.now()): { workers: number; online: number; busy: number; idle: number; offline: number; phones: number } {
    const all = this.list(now);
    return {
      workers: all.length,
      online: all.filter(w => w.status !== 'offline').length,
      busy: all.filter(w => w.status === 'busy').length,
      idle: all.filter(w => w.status === 'idle').length,
      offline: all.filter(w => w.status === 'offline').length,
      phones: all.filter(w => w.role === 'phone').length,
    };
  }

  private sweep(now: number): void {
    for (const worker of this.workers.values()) this.refreshStatus(worker, now);
  }

  private refreshStatus(worker: WorkerRecord, now: number): void {
    if (now - worker.lastHeartbeat > this.ttlMs) {
      worker.status = 'offline';
      return;
    }
    worker.status = worker.active >= worker.maxConcurrent ? 'busy' : 'idle';
  }
}

/** A worker with no engines listed accepts anything. */
function advertises(worker: WorkerRecord, engine: string): boolean {
  const engines = worker.capabilities.engines;
  if (!engines || engines.length === 0) return true;
  return engines.map(e => e.toLowerCase()).includes(engine.toLowerCase());
}

/** Strip the token before a worker is shown to the UI. */
export function workerView(worker: WorkerRecord): WorkerView {
  const { token: _token, ...view } = worker;
  return view;
}

// ---------------------------------------------------------------------------
// Dispatch: the one place that talks to a worker over HTTP.
// ---------------------------------------------------------------------------

export interface JobRequest {
  /** The engine the job needs, e.g. 'comfyui'. */
  engine: string;
  /** The task name for the worker's logs, e.g. 'video_render'. */
  task: string;
  payload: Record<string, unknown>;
}

export interface JobResult {
  ok: boolean;
  /** The worker id that ran it (or was attempted). */
  worker: string;
  /** Parsed JSON body on success, or null. */
  output: unknown;
  error?: string;
}

export interface DispatchDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Send one job to one worker and wait for the result. The slot is acquired
 * before the call and released after, so the scheduler never over-commits a
 * worker. A failure returns `ok: false` with the reason; the caller decides
 * whether to retry on another worker.
 */
export async function dispatchJob(
  mesh: WorkerMesh,
  workerId: string,
  job: JobRequest,
  deps: DispatchDeps = {},
): Promise<JobResult> {
  const worker = mesh.list().find(w => w.id === workerId);
  if (!worker) return { ok: false, worker: workerId, output: null, error: `Walang worker ${workerId}.` };
  if (!mesh.acquire(workerId)) {
    return { ok: false, worker: workerId, output: null, error: `Puno o offline ang worker ${workerId}.` };
  }
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 15 * 60_000;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (worker.token) headers['Authorization'] = `Bearer ${worker.token}`;
    const res = await doFetch(`${worker.url}/job`, {
      method: 'POST',
      headers,
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      mesh.release(workerId, false);
      return { ok: false, worker: workerId, output: null, error: `Worker ${workerId} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
    }
    const output = await res.json().catch(() => null);
    mesh.release(workerId, true);
    return { ok: true, worker: workerId, output };
  } catch (error: any) {
    mesh.release(workerId, false);
    return { ok: false, worker: workerId, output: null, error: error?.message || 'dispatch failed' };
  }
}

/**
 * Place a job on the best available worker and run it. When no worker is free
 * this returns `ok: false` with a clear reason instead of running anything
 * locally — the caller decides whether to fall back.
 */
export async function dispatchToMesh(
  mesh: WorkerMesh,
  job: JobRequest,
  deps: DispatchDeps = {},
): Promise<JobResult> {
  const worker = mesh.select(job.engine);
  if (!worker) {
    return {
      ok: false,
      worker: '',
      output: null,
      error: `Walang available na worker para sa '${job.engine}'.`,
    };
  }
  return dispatchJob(mesh, worker.id, job, deps);
}
