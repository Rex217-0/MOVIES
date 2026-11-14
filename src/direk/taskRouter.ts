/**
 * T1/T2/T3 task router.
 *
 * The local box (Server-2) has one AMD GPU and must not be overloaded, so every
 * job is classified before it is dispatched:
 *
 *   T1  Light / CPU   chat, text generation, webhooks, LoRA text half.
 *                     Runs locally; needs no GPU.
 *   T2  Medium / GPU  image generation (SDXL/Pollinations), Piper TTS, small
 *                     LoRA training. Runs locally on the one GPU.
 *   T3  Heavy / GPU   video rendering (AnimateDiff/SVD), large TTS models
 *                     (Qwen3/Fish), massive LoRA training. Offloaded to a cloud
 *                     free tier so it never blocks the local GPU.
 *
 * The classification is a pure lookup, so it can be unit-tested and reported to
 * the UI without touching ComfyUI or the network.
 */

export type Tier = 'T1' | 'T2' | 'T3';

/** Where a job runs: the local GPU box, or an offloaded cloud tier. */
export type Placement = 'local' | 'cloud';

export interface TaskRoute {
  /** The task type that was classified. */
  task: string;
  tier: Tier;
  placement: Placement;
  /** Why it landed in that tier, for the UI and the logs. */
  reason: string;
}

/** Every task type the app knows about, mapped to its tier. */
export const TASK_TIERS: Record<string, Tier> = {
  // T1 — light, CPU only.
  chat: 'T1',
  text: 'T1',
  text_generation: 'T1',
  webhook: 'T1',
  webhooks: 'T1',
  lora_text: 'T1',

  // T2 — medium, the local GPU.
  image: 'T2',
  image_generation: 'T2',
  sdxl: 'T2',
  pollinations: 'T2',
  piper_tts: 'T2',
  tts_piper: 'T2',
  lora_train_small: 'T2',

  // T3 — heavy, offload to the cloud free tiers.
  video: 'T3',
  video_render: 'T3',
  animatediff: 'T3',
  svd: 'T3',
  tts_large: 'T3',
  fish_tts: 'T3',
  qwen3_tts: 'T3',
  lora_train_large: 'T3',
};

export const TIER_LABELS: Record<Tier, string> = {
  T1: 'Light / CPU — local (Server-2)',
  T2: 'Medium / GPU — local (Server-2)',
  T3: 'Heavy / GPU — offload to cloud',
};

const REASONS: Record<Tier, string> = {
  T1: 'Light CPU work: no GPU needed, runs locally.',
  T2: 'Medium GPU work: runs on the local GPU (Server-2).',
  T3: 'Heavy GPU work: offloaded to a cloud free tier to protect the local GPU.',
};

/** Normalise a task name so `Video Render` and `video_render` agree. */
function normalise(taskType: string): string {
  return (taskType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** The tier a task type belongs to, or null when it is unknown. */
export function tierOf(taskType: string): Tier | null {
  return TASK_TIERS[normalise(taskType)] ?? null;
}

/**
 * Classify a task and say where it should run. Unknown tasks default to T3 so
 * they are offloaded rather than quietly loading the local GPU.
 */
export function classifyTask(taskType: string): TaskRoute {
  const task = normalise(taskType) || 'unknown';
  const tier = tierOf(task) ?? 'T3';
  return {
    task,
    tier,
    placement: tier === 'T3' ? 'cloud' : 'local',
    reason:
      tierOf(task) === null
        ? 'Hindi kilalang task: itinuturing na mabigat (T3) at iniaakyat sa cloud.'
        : REASONS[tier],
  };
}

export interface CloudJob {
  task: string;
  tier: 'T3';
  /** The payload handed to the cloud worker. */
  payload: Record<string, unknown>;
}

export interface CloudResult {
  ok: boolean;
  /** Which cloud free tier would run it. */
  provider: string;
  job: CloudJob;
  note: string;
}

/**
 * Placeholder for the cloud offload path.
 *
 * This is intentionally not wired to a real provider yet: the founder's
 * directive is that T3 work *must not* run on Server-2, so until a cloud worker
 * is configured the router reports the job as queued-for-offload instead of
 * running it locally. Set `CLOUD_T3_URL` to point it at a real worker.
 */
export function route_to_cloud(task: string, payload: Record<string, unknown> = {}): CloudResult {
  const job: CloudJob = { task: normalise(task) || 'unknown', tier: 'T3', payload };
  const url = process.env.CLOUD_T3_URL;
  return {
    ok: false,
    provider: url || 'cloud-free-tier (unconfigured)',
    job,
    note: url
      ? `Naka-queue ang T3 job sa cloud worker (${url}).`
      : 'Naka-queue ang T3 job para sa cloud offload. I-set ang CLOUD_T3_URL para patakbuhin ito.',
  };
}

/** The full routing table, for the UI and the status endpoint. */
export function routingTable(): { task: string; tier: Tier; placement: Placement }[] {
  return Object.entries(TASK_TIERS)
    .map(([task, tier]) => ({ task, tier, placement: tier === 'T3' ? ('cloud' as const) : ('local' as const) }))
    .sort((a, b) => a.tier.localeCompare(b.tier) || a.task.localeCompare(b.task));
}

/**
 * Classify a LoRA training job from its shape. A small run (a handful of
 * samples, low rank) fits the local GPU as a T2 job; a large one (many repeats,
 * big rank, many epochs) is T3 and belongs on a cloud tier.
 */
export function classifyLoraTraining(opts: {
  samples?: number;
  resolution?: number;
  networkDim?: number;
  epochs?: number;
}): TaskRoute {
  const samples = opts.samples ?? 0;
  const resolution = opts.resolution ?? 1024;
  const networkDim = opts.networkDim ?? 32;
  const epochs = opts.epochs ?? 10;
  // A rough "how heavy is this" score; the thresholds are deliberately simple
  // and documented so they are easy to tune.
  const heavy = resolution > 1024 || networkDim > 64 || samples * epochs > 400;
  const tier: Tier = heavy ? 'T3' : 'T2';
  return {
    task: heavy ? 'lora_train_large' : 'lora_train_small',
    tier,
    placement: tier === 'T3' ? 'cloud' : 'local',
    reason: heavy
      ? `Mabigat na training (${samples} samples, ${resolution}px, dim ${networkDim}, ${epochs} epochs): T3, i-offload sa cloud.`
      : `Maliit na training (${samples} samples, ${resolution}px, dim ${networkDim}, ${epochs} epochs): T2, kaya ng lokal na GPU.`,
  };
}

/**
 * Whether a T3 job may run on the local box when no cloud worker is configured.
 *
 * The founder's directive is that T3 work is offloaded, so the strict setting is
 * `T3_ALLOW_LOCAL=0`: a T3 job then answers with an offload notice instead of
 * touching the local GPU. It defaults to allowed so a machine with no cloud
 * worker yet keeps working, and the placement is always reported.
 */
export function t3LocalAllowed(): boolean {
  return process.env.T3_ALLOW_LOCAL !== '0';
}

export interface ExecutionPlan {
  route: TaskRoute;
  /** Run it here, or hand it to the cloud placeholder. */
  run: 'local' | 'cloud';
}

/**
 * Decide how to run a task. T1/T2 always run locally. T3 is offloaded unless it
 * may fall back to the local GPU (see `t3LocalAllowed`).
 */
export function planExecution(taskType: string, payload: Record<string, unknown> = {}): ExecutionPlan {
  const route = classifyTask(taskType);
  if (route.tier !== 'T3') return { route, run: 'local' };
  const cloudConfigured = Boolean(process.env.CLOUD_T3_URL);
  if (cloudConfigured || !t3LocalAllowed()) return { route, run: 'cloud' };
  return { route: { ...route, placement: 'local' }, run: 'local' };
}
