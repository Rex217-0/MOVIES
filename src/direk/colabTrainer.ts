/**
 * The Colab training backend.
 *
 * Same interface as the local trainer (`TrainBackend`), but the run happens in
 * a Colab notebook instead of here. The two sides never talk directly; they
 * trade files inside one Drive folder (see `trainDrive.ts`):
 *
 *   Server-2 -> Drive (dataset + job.json) -> Colab (training)
 *            -> Drive (output + manifest.json) -> Server-2 (verify + publish)
 *
 * The app never invents a result. If Drive is not configured the status is
 * honestly unavailable; if the notebook reports FAILED the job is failed; if the
 * downloaded file does not match its manifest sha256 the job is failed and the
 * file is never published to ComfyUI.
 *
 * Configuration (environment variables):
 *   TRAIN_BACKEND          `colab` selects this backend.
 *   COLAB_DRIVE_ROOT       A Drive folder that is a real path (Drive for
 *                          Desktop). Preferred; no API token needed.
 *   COLAB_DRIVE_FOLDER_ID  A Drive folder id, used with the Drive API v3 when
 *                          there is no mount.
 *   COLAB_POLL_MS          How often to read status.json, default 12000.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  driveStoreFromEnv, sha256, type DriveStore,
} from './trainDrive.ts';
import {
  type StartTrainOptions, type TrainBackend, type TrainBackendName,
  type TrainJob, type TrainerStatus,
} from './trainer.ts';

/** The states the Colab notebook records in status.json. */
export type ColabState = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface ColabStatus {
  state: ColabState;
  epoch?: number;
  total_epochs?: number;
  progress?: number;
  message?: string;
  error?: string;
  updated_at?: string;
}

/** One entry in the manifest.json the notebook writes after training. */
export interface ManifestEntry {
  name: string;
  bytes?: number;
  sha256: string;
}

export interface ColabManifest {
  files: ManifestEntry[];
}

/** The structured training parameters, parsed once from the kohya config. */
export interface TrainArgs {
  resolution: number;
  num_repeats: number;
  network_dim: number;
  network_alpha: number;
  learning_rate: number;
  optimizer_type: string;
  lr_scheduler: string;
  max_train_epochs: number;
  save_every_n_epochs: number;
  mixed_precision: string;
  seed: number;
  batch_size: number;
  network_module: string;
  save_model_as: string;
}

export interface ColabJobDoc {
  job_id: string;
  title: string;
  trigger: string;
  created_at: string;
  /** Paths relative to the Drive root. */
  dataset: string;
  output: string;
  output_name: string;
  base_model: string;
  /** Absolute path on the Colab VM where the base model should live. */
  colab_base_model_dir: string;
  train_args: TrainArgs;
}

/** Map a Colab state onto the app's job status. */
export function jobStatusForState(state: ColabState): TrainJob['status'] {
  switch (state) {
    case 'DONE': return 'done';
    case 'FAILED': return 'failed';
    case 'CANCELLED': return 'cancelled';
    case 'RUNNING':
    case 'QUEUED':
    default: return 'running';
  }
}

/**
 * Pull the training parameters out of a kohya TOML config. This is the one
 * source of truth: the same config the local trainer would run, so a Colab run
 * and a local run train the same way.
 */
export function parseKohyaConfig(toml: string): TrainArgs {
  const raw = new Map<string, string>();
  for (const line of toml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!raw.has(key)) raw.set(key, value);
  }
  const num = (key: string, fallback: number): number => {
    const v = Number(raw.get(key));
    return Number.isFinite(v) ? v : fallback;
  };
  const str = (key: string, fallback: string): string => raw.get(key) ?? fallback;
  return {
    resolution: num('resolution', 1024),
    num_repeats: num('num_repeats', 10),
    network_dim: num('network_dim', 32),
    network_alpha: num('network_alpha', 16),
    learning_rate: num('learning_rate', 1e-4),
    optimizer_type: str('optimizer_type', 'AdamW8bit'),
    lr_scheduler: str('lr_scheduler', 'cosine_with_restarts'),
    max_train_epochs: num('max_train_epochs', 10),
    save_every_n_epochs: num('save_every_n_epochs', 2),
    mixed_precision: str('mixed_precision', 'fp16'),
    seed: num('seed', 42),
    batch_size: num('batch_size', 1),
    network_module: str('network_module', 'networks.lora'),
    save_model_as: str('save_model_as', 'safetensors'),
  };
}

/** The Drive paths for one job. */
export function jobPaths(jobId: string) {
  const base = `jobs/${jobId}`;
  return {
    base,
    job: `${base}/job.json`,
    dataset: `${base}/dataset`,
    status: `${base}/status.json`,
    cancel: `${base}/cancel.flag`,
    output: `${base}/output`,
    manifest: `${base}/manifest.json`,
  };
}

/** Build the job.json document the notebook reads. */
export function buildColabJob(opts: {
  id: string;
  title: string;
  trigger: string;
  config: string;
  baseModel: string;
  createdAt?: string;
}): ColabJobDoc {
  const p = jobPaths(opts.id);
  return {
    job_id: opts.id,
    title: opts.title,
    trigger: opts.trigger,
    created_at: opts.createdAt ?? new Date().toISOString(),
    dataset: p.dataset,
    output: p.output,
    output_name: `${opts.trigger}_colab`,
    base_model: opts.baseModel,
    colab_base_model_dir: '/content/models',
    train_args: parseKohyaConfig(opts.config),
  };
}

/** Read and validate status.json. A missing file reads as QUEUED. */
export async function readColabStatus(store: DriveStore, jobId: string): Promise<ColabStatus> {
  const buf = await store.read(jobPaths(jobId).status);
  if (!buf) return { state: 'QUEUED' };
  try {
    const json = JSON.parse(buf.toString('utf8')) as Partial<ColabStatus>;
    const state = (json.state || 'QUEUED').toUpperCase() as ColabState;
    const known: ColabState[] = ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'];
    return { ...json, state: known.includes(state) ? state : 'QUEUED' };
  } catch {
    return { state: 'QUEUED', message: 'status.json ay hindi mabasa (invalid JSON).' };
  }
}

/** Read manifest.json, or null when it is absent or malformed. */
export async function readColabManifest(store: DriveStore, jobId: string): Promise<ColabManifest | null> {
  const buf = await store.read(jobPaths(jobId).manifest);
  if (!buf) return null;
  try {
    const json = JSON.parse(buf.toString('utf8')) as ColabManifest;
    return Array.isArray(json.files) ? json : null;
  } catch {
    return null;
  }
}

export interface ArtifactResult {
  ok: boolean;
  name?: string;
  data?: Buffer;
  reason?: string;
}

/**
 * Download the trained .safetensors and verify it against the manifest. A hash
 * mismatch, a missing manifest or a missing file all fail the job; the file is
 * only returned when it is verified, so nothing unverified is ever published.
 */
export async function collectVerifiedArtifact(
  store: DriveStore,
  jobId: string,
): Promise<ArtifactResult> {
  const manifest = await readColabManifest(store, jobId);
  if (!manifest || manifest.files.length === 0) {
    return { ok: false, reason: 'Walang manifest.json — hindi ma-verify ang output.' };
  }
  const entries = await store.list(jobPaths(jobId).output);
  const weightFiles = entries.filter(f => /\.safetensors$/i.test(f));
  if (weightFiles.length === 0) {
    return { ok: false, reason: 'Walang .safetensors sa output/ folder.' };
  }
  // Prefer a file the manifest names; otherwise fall back to the newest listed.
  const chosen =
    weightFiles.find(f => manifest.files.some(m => m.name === path.posix.basename(f))) ??
    weightFiles[weightFiles.length - 1];
  const name = path.posix.basename(chosen);
  const data = await store.read(chosen);
  if (!data) return { ok: false, reason: `Hindi mabasa ang ${name} mula sa Drive.` };

  const entry = manifest.files.find(m => m.name === name);
  if (!entry) return { ok: false, reason: `Wala sa manifest ang ${name}.` };
  const actual = sha256(data);
  if (actual !== entry.sha256.toLowerCase()) {
    return {
      ok: false,
      name,
      reason: `sha256 mismatch para sa ${name}: inaasahan ${entry.sha256.slice(0, 12)}…, nakuha ${actual.slice(0, 12)}…`,
    };
  }
  return { ok: true, name, data };
}

export interface ColabBackendDeps {
  /** Resolve the Drive store; injected in tests to mock Drive. */
  store?: () => DriveStore | null;
  /** Where verified weights are staged before publish. Defaults to a temp dir. */
  stageDir?: string;
  /** Poll interval in milliseconds. */
  pollMs?: number;
}

/**
 * The Colab backend: writes the job to Drive, polls status.json, and on DONE
 * downloads and verifies the weights before publishing them.
 */
export class ColabTrainBackend implements TrainBackend {
  readonly name: TrainBackendName = 'colab';
  private job: TrainJob | null = null;
  private jobDoc: ColabJobDoc | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly deps: ColabBackendDeps;
  private readonly listeners = new Set<(line: string) => void>();
  private lastState: ColabState | null = null;

  constructor(deps: ColabBackendDeps = {}) {
    this.deps = deps;
  }

  private store(): DriveStore | null {
    return this.deps.store ? this.deps.store() : driveStoreFromEnv();
  }

  private pollMs(): number {
    if (this.deps.pollMs) return this.deps.pollMs;
    const n = Number(process.env.COLAB_POLL_MS);
    return Number.isFinite(n) && n > 0 ? n : 12000;
  }

  status(): TrainerStatus {
    const store = this.store();
    // The notebook writes to Drive; this local path is only where the verified
    // weights are staged, so it mirrors the local backend's output dir.
    const outputDir =
      this.job?.outputDir || process.env.KOHYA_OUTPUT_DIR || path.join(process.cwd(), 'lora_runs');
    const base = {
      dir: process.env.COLAB_DRIVE_ROOT || process.env.COLAB_DRIVE_FOLDER_ID || '',
      script: null,
      python: '',
      base_model: process.env.KOHYA_BASE_MODEL || null,
      output_dir: outputDir,
    };
    if (!store) {
      return {
        ...base,
        available: false,
        reason:
          'Hindi naka-configure ang Drive para sa Colab mode. I-set ang COLAB_DRIVE_ROOT (Drive for Desktop path) o COLAB_DRIVE_FOLDER_ID.',
      };
    }
    return { ...base, available: true };
  }

  current(): TrainJob | null {
    return this.job;
  }

  onLine(fn: (line: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recentLog(max = 100): string[] {
    return (this.job?.log ?? []).slice(-max);
  }

  private emit(line: string) {
    const text = line.replace(/\s+$/, '');
    if (!text) return;
    if (this.job) {
      this.job.log.push(text);
      if (this.job.log.length > 400) this.job.log.splice(0, this.job.log.length - 400);
    }
    for (const fn of this.listeners) {
      try { fn(text); } catch { /* a dead listener must not stop the run */ }
    }
  }

  async start(opts: StartTrainOptions): Promise<TrainJob> {
    if (this.job?.status === 'running') {
      throw new Error('May tumatakbong training na. Hintayin itong matapos o i-cancel.');
    }
    const store = this.store();
    if (!store) throw new Error(this.status().reason);
    const baseModel = process.env.KOHYA_BASE_MODEL || 'stabilityai/stable-diffusion-xl-base-1.0';

    const p = jobPaths(opts.id);
    const doc = buildColabJob({
      id: opts.id,
      title: opts.title,
      trigger: opts.trigger,
      config: opts.config,
      baseModel,
    });
    this.jobDoc = doc;
    this.lastState = null;

    const job: TrainJob = {
      id: opts.id,
      title: opts.title,
      trigger: opts.trigger,
      status: 'running',
      startedAt: new Date().toISOString(),
      outputDir: this.deps.stageDir || path.join(process.cwd(), 'lora_runs', opts.id, 'colab'),
      log: [],
    };
    this.job = job;

    // Upload the dataset (images + captions) and the job document.
    let uploaded = 0;
    for (const { name, text } of opts.captions) {
      await store.write(`${p.dataset}/${name}.txt`, Buffer.from(`${text}\n`, 'utf8'));
      const png = opts.images.get(name);
      if (png) {
        await store.write(`${p.dataset}/${name}.png`, png);
        uploaded++;
      }
    }
    await store.write(p.job, Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8'));
    // A fresh run must not inherit an old cancel request.
    await store.remove(p.cancel);

    this.emit(`colab: ${uploaded} larawan + job.json nai-upload sa ${p.base}`);
    this.emit(`colab: hinihintay ang notebook (status.json)...`);
    this.startPolling(opts);
    return job;
  }

  private startPolling(opts: StartTrainOptions) {
    this.stopPolling();
    const tick = async () => {
      try {
        await this.poll(opts);
      } catch (error: any) {
        this.emit(`warning: hindi mabasa ang status.json: ${error?.message || error}`);
      }
    };
    this.timer = setInterval(tick, this.pollMs());
    // Do not hold the process open for a poll timer.
    this.timer.unref?.();
  }

  private stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll: read status.json, act on a transition, finish on a terminal state. */
  private async poll(opts: StartTrainOptions) {
    const job = this.job;
    const store = this.store();
    if (!job || !store || job.status !== 'running') return;
    const status = await readColabStatus(store, job.id);
    if (status.state !== this.lastState) {
      this.lastState = status.state;
      const epoch = status.epoch != null ? ` epoch ${status.epoch}${status.total_epochs ? `/${status.total_epochs}` : ''}` : '';
      this.emit(`colab: ${status.state}${epoch}${status.message ? ` — ${status.message}` : ''}`);
    }
    if (status.state === 'RUNNING' || status.state === 'QUEUED') return;

    this.stopPolling();
    job.finishedAt = new Date().toISOString();

    if (status.state === 'CANCELLED') {
      job.status = 'cancelled';
      this.emit('colab: kinansela ng notebook.');
      return;
    }
    if (status.state === 'FAILED') {
      job.status = 'failed';
      job.error = status.error || status.message || 'Failed ang Colab training.';
      this.emit(`error: ${job.error}`);
      return;
    }
    // DONE: download and verify before publishing.
    const artifact = await collectVerifiedArtifact(store, job.id);
    if (!artifact.ok || !artifact.data || !artifact.name) {
      job.status = 'failed';
      job.error = artifact.reason || 'Hindi ma-verify ang output.';
      this.emit(`error: ${job.error}`);
      return;
    }
    // Stage the verified bytes on disk and hand them to the caller, exactly as
    // the local backend hands over a finished .safetensors path. Nothing is
    // published here; the route decides.
    try {
      const stageDir = this.deps.stageDir || path.join(process.cwd(), 'lora_runs', job.id, 'colab');
      fs.mkdirSync(stageDir, { recursive: true });
      const staged = path.join(stageDir, artifact.name);
      fs.writeFileSync(staged, artifact.data);
      job.artifact = staged;
      this.emit(`colab: na-verify ang ${artifact.name} (${artifact.data.length} bytes, sha256 OK).`);
      if (opts.onArtifact) {
        try { opts.onArtifact(staged); } catch (e: any) {
          this.emit(`warning: hindi na-publish ang LoRA: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      job.status = 'failed';
      job.error = `Hindi maisulat ang verified na file: ${e?.message || e}`;
      this.emit(`error: ${job.error}`);
      return;
    }
    job.status = 'done';
  }

  async cancel(): Promise<boolean> {
    if (this.job?.status !== 'running') return false;
    const store = this.store();
    if (!store) return false;
    await store.write(jobPaths(this.job.id).cancel, Buffer.from(`${new Date().toISOString()}\n`, 'utf8'));
    this.emit('colab: cancel.flag naisulat — hihinto ang notebook sa pagitan ng epoch.');
    return true;
  }
}
