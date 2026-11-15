/**
 * ComfyUI image backend.
 *
 * When a ComfyUI server is reachable it becomes the image backend, which makes
 * image generation free (local GPU) instead of the paid Gemini image model.
 *
 * Configuration (environment variables):
 *   COMFYUI_URL         Base URL, default http://127.0.0.1:8188
 *   COMFYUI_CHECKPOINT  Checkpoint name for the default workflow
 *   COMFYUI_WORKFLOW    Path to a workflow JSON template (API format). The
 *                       placeholders __PROMPT__, __NEGATIVE__, __SEED__,
 *                       __WIDTH__, __HEIGHT__ and __CHECKPOINT__ are replaced.
 *   COMFYUI_TIMEOUT_MS  Per-image timeout, default 180000
 *   COMFYUI_LORAS_DIR   Where trained LoRAs are published for ComfyUI to load,
 *                       default <ComfyUI models>/loras when discoverable
 *
 * The default workflow is a plain SDXL text-to-image graph, and it grows a
 * LoraLoader node when a trained LoRA is chosen. Users with a custom setup
 * (a different sampler, extra nodes) point COMFYUI_WORKFLOW at their own
 * exported workflow instead; it may use the __LORA__ and __LORA_STRENGTH__
 * placeholders.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_NEGATIVE = 'blurry, low quality, watermark, text, deformed';

export interface LoraChoice {
  /** LoRA file name as ComfyUI knows it, e.g. `direk_x.safetensors`. */
  name: string;
  /** Blend strength for model and clip, default 1. */
  strength?: number;
}

export interface LoraFile {
  name: string;
  bytes: number;
  modified: string;
}

/** Normalise a strength into a sane range; defaults to 1. */
export function clampStrength(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(-2, Math.min(2, n));
}

/** Where trained LoRAs are published. Falls back to a local folder. */
export function lorasDir(): string {
  return process.env.COMFYUI_LORAS_DIR || path.join(process.cwd(), 'comfy_loras');
}

/**
 * Publish a trained LoRA so ComfyUI can load it: copy the file into the LoRA
 * folder ComfyUI scans, and return its name there.
 */
export function publishLora(sourcePath: string): LoraFile {
  const dir = lorasDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(sourcePath);
  const dest = path.join(dir, name);
  if (path.resolve(sourcePath) !== path.resolve(dest)) fs.copyFileSync(sourcePath, dest);
  const stat = fs.statSync(dest);
  return { name, bytes: stat.size, modified: stat.mtime.toISOString() };
}

/** List the LoRA files published for ComfyUI. */
export function listLoras(): LoraFile[] {
  try {
    return fs
      .readdirSync(lorasDir())
      .filter(f => /\.(safetensors|ckpt|pt)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(lorasDir(), f));
        return { name: f, bytes: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

export function comfyUrl(): string {
  return (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
}

function timeoutMs(): number {
  const n = Number(process.env.COMFYUI_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 180000;
}

/** A minimal SDXL text-to-image graph in ComfyUI API format. */
export function defaultWorkflow(
  prompt: string,
  negative: string,
  seed: number,
  width: number,
  height: number,
  checkpoint: string,
  lora?: LoraChoice,
): Record<string, unknown> {
  const graph: Record<string, unknown> = {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed, steps: 24, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'direk', images: ['8', 0] } },
  };

  // With a LoRA, the sampler and both text encoders read from the loader
  // instead of the checkpoint. Node 10 is the LoraLoader.
  if (lora?.name) {
    graph['10'] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: lora.name,
        strength_model: lora.strength,
        strength_clip: lora.strength,
        model: ['4', 0],
        clip: ['4', 1],
      },
    };
    (graph['3'] as any).inputs.model = ['10', 0];
    (graph['6'] as any).inputs.clip = ['10', 1];
    (graph['7'] as any).inputs.clip = ['10', 1];
  }

  return graph;
}

/** Load the workflow template from disk and substitute the placeholders. */
export function buildWorkflow(
  prompt: string,
  opts: {
    negative?: string; seed?: number; width?: number; height?: number;
    lora?: LoraChoice;
  } = {},
): Record<string, unknown> {
  const negative = opts.negative ?? DEFAULT_NEGATIVE;
  const seed = opts.seed ?? Math.floor(Math.random() * 1_000_000_000);
  const width = opts.width ?? 1024;
  const height = opts.height ?? 1024;
  const checkpoint = process.env.COMFYUI_CHECKPOINT || 'sd_xl_base_1.0.safetensors';
  const lora = opts.lora?.name ? opts.lora : undefined;

  const templatePath = process.env.COMFYUI_WORKFLOW;
  if (templatePath && fs.existsSync(templatePath)) {
    const raw = fs.readFileSync(templatePath, 'utf8')
      .replaceAll('__PROMPT__', escapeJson(prompt))
      .replaceAll('__NEGATIVE__', escapeJson(negative))
      .replaceAll('__SEED__', String(seed))
      .replaceAll('__WIDTH__', String(width))
      .replaceAll('__HEIGHT__', String(height))
      .replaceAll('__CHECKPOINT__', escapeJson(checkpoint))
      .replaceAll('__LORA__', escapeJson(lora?.name ?? ''))
      .replaceAll('__LORA_STRENGTH__', String(lora?.strength ?? 1));
    return JSON.parse(raw);
  }
  return defaultWorkflow(prompt, negative, seed, width, height, checkpoint, lora);
}

function escapeJson(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

/** Is a ComfyUI server reachable right now? */
export async function comfyAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${comfyUrl()}/system_stats`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Generate one image. Queues the workflow, waits for it to finish, then
 * downloads the first image it produced.
 */
export async function generateWithComfy(
  prompt: string,
  opts: { negative?: string; width?: number; height?: number; lora?: LoraChoice } = {},
): Promise<Buffer> {
  const base = comfyUrl();
  const workflow = buildWorkflow(prompt, opts);

  const queued = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: `direk-${Date.now()}` }),
  });
  if (!queued.ok) {
    throw new Error(`ComfyUI /prompt returned ${queued.status}`);
  }
  const { prompt_id: promptId } = (await queued.json()) as { prompt_id?: string };
  if (!promptId) throw new Error('ComfyUI did not return a prompt_id');

  const image = await waitForImage(base, promptId, timeoutMs());
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  const view = await fetch(`${base}/view?${params}`);
  if (!view.ok) throw new Error(`ComfyUI /view returned ${view.status}`);
  return Buffer.from(await view.arrayBuffer());
}

/**
 * The placeholders a video workflow template may use. Every one of these is
 * replaced before the graph is sent to ComfyUI `/prompt`.
 */
export const VIDEO_PLACEHOLDERS = [
  '__PROMPT__', '__NEGATIVE__', '__SEED__', '__WIDTH__', '__HEIGHT__', '__FRAMES__', '__CHECKPOINT__',
] as const;

/**
 * Tokens that look like a placeholder (`__NAME__`) but are not one the builder
 * fills. They would survive into the graph and make ComfyUI reject the prompt,
 * so the builder refuses them with a clear message instead of sending a broken
 * workflow. The scan runs on the raw template, so a prompt that itself contains
 * `__SEED__` is never mistaken for an unfilled placeholder.
 */
export function unfilledPlaceholders(template: string): string[] {
  const known = new Set<string>(VIDEO_PLACEHOLDERS);
  const found = template.match(/__[A-Z0-9_]+__/g) ?? [];
  return [...new Set(found.filter(token => !known.has(token)))];
}

/**
 * Build the video workflow. Unlike images there is no built-in default: video
 * needs an AnimateDiff/SVD graph that only the user's ComfyUI has, so we require
 * COMFYUI_VIDEO_WORKFLOW and fail with a clear message when it is missing, when
 * the file is not there, or when the template carries a placeholder we cannot
 * fill. Every known placeholder is substituted before the graph is returned.
 */
export function buildVideoWorkflow(
  prompt: string,
  opts: { negative?: string; seed?: number; width?: number; height?: number; frames?: number } = {},
): Record<string, unknown> {
  const templatePath = process.env.COMFYUI_VIDEO_WORKFLOW;
  if (!templatePath) {
    throw new Error(
      'Walang video workflow. I-set ang COMFYUI_VIDEO_WORKFLOW sa isang AnimateDiff/SVD ' +
      `workflow na na-export sa API format (placeholders ${VIDEO_PLACEHOLDERS.join(', ')}).`,
    );
  }
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Walang workflow file sa COMFYUI_VIDEO_WORKFLOW='${templatePath}'.`);
  }
  const negative = opts.negative ?? DEFAULT_NEGATIVE;
  const seed = opts.seed ?? Math.floor(Math.random() * 1_000_000_000);
  const width = opts.width ?? 832;
  const height = opts.height ?? 480;
  const frames = opts.frames ?? 49;

  const template = fs.readFileSync(templatePath, 'utf8');
  const unfilled = unfilledPlaceholders(template);
  if (unfilled.length) {
    throw new Error(
      `Hindi napapalitan ang placeholder(s) ${unfilled.join(', ')} sa ${templatePath}. ` +
      `Ang sinusuportahan ay ${VIDEO_PLACEHOLDERS.join(', ')}.`,
    );
  }

  const raw = template
    .replaceAll('__PROMPT__', escapeJson(prompt))
    .replaceAll('__NEGATIVE__', escapeJson(negative))
    .replaceAll('__SEED__', String(seed))
    .replaceAll('__WIDTH__', String(width))
    .replaceAll('__HEIGHT__', String(height))
    .replaceAll('__FRAMES__', String(frames))
    .replaceAll('__CHECKPOINT__', escapeJson(process.env.COMFYUI_CHECKPOINT || 'sd_xl_base_1.0.safetensors'));
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error: any) {
    throw new Error(`Hindi wastong JSON ang workflow ${templatePath}: ${error?.message || error}`);
  }
}

/** True when a ComfyUI video workflow has been configured. */
export function comfyVideoConfigured(): boolean {
  const p = process.env.COMFYUI_VIDEO_WORKFLOW;
  return Boolean(p && fs.existsSync(p));
}

export type ComfyVideoProblem =
  | 'disabled'
  | 'no-workflow'
  | 'workflow-missing'
  | 'placeholder'
  | 'unreachable'
  | 'ready';

export interface ComfyVideoDiagnosis {
  ready: boolean;
  problem: ComfyVideoProblem;
  /** The ComfyUI base URL that was probed. */
  url: string;
  /** The configured COMFYUI_VIDEO_WORKFLOW path (or '' when unset). */
  workflow: string;
  workflow_exists: boolean;
  reachable: boolean;
  /** Placeholders the builder cannot fill, when the problem is `placeholder`. */
  unfilled: string[];
  /** A plain-language reason, for the logs and the API response. */
  detail: string;
}

/**
 * Explain in one place exactly why the ComfyUI video backend is or is not
 * usable: the server disabled it, no workflow is configured, the workflow file
 * is missing, the URL is unreachable, or the template has placeholders the
 * builder cannot fill. `ready` is true only when a real render can start.
 */
export async function diagnoseComfyVideo(): Promise<ComfyVideoDiagnosis> {
  const url = comfyUrl();
  const workflow = process.env.COMFYUI_VIDEO_WORKFLOW || '';
  const workflowExists = Boolean(workflow && fs.existsSync(workflow));
  const base = { url, workflow, workflow_exists: workflowExists, reachable: false, unfilled: [] as string[] };

  if (process.env.COMFYUI_DISABLE === '1') {
    return {
      ...base, ready: false, problem: 'disabled',
      detail: 'COMFYUI_DISABLE=1: hindi pinapayagan ang ComfyUI.',
    };
  }
  if (!workflow) {
    return {
      ...base, ready: false, problem: 'no-workflow',
      detail: 'Walang COMFYUI_VIDEO_WORKFLOW. I-set ito sa isang AnimateDiff/SVD workflow (API format).',
    };
  }
  if (!workflowExists) {
    return {
      ...base, ready: false, problem: 'workflow-missing',
      detail: `Walang workflow file sa COMFYUI_VIDEO_WORKFLOW='${workflow}'.`,
    };
  }
  let unfilled: string[] = [];
  try {
    unfilled = unfilledPlaceholders(fs.readFileSync(workflow, 'utf8'));
  } catch {
    /* an unreadable file surfaces as `unreachable` on the next step */
  }
  if (unfilled.length) {
    return {
      ...base, ready: false, problem: 'placeholder', unfilled,
      detail: `Hindi napapalitan ang placeholder(s) ${unfilled.join(', ')} sa workflow. ` +
        `Gamitin lamang ang ${VIDEO_PLACEHOLDERS.join(', ')}.`,
    };
  }
  if (!(await comfyAvailable())) {
    return {
      ...base, ready: false, problem: 'unreachable',
      detail: `Hindi maabot ang ComfyUI sa ${url}/system_stats.`,
    };
  }
  return {
    ...base, ready: true, reachable: true, problem: 'ready',
    detail: `Handa ang ComfyUI sa ${url} gamit ang workflow ${workflow}.`,
  };
}

/**
 * Generate one video locally. Queues the AnimateDiff/SVD workflow, waits for it
 * to finish, then downloads the produced file. Free, on the local GPU.
 */
export async function generateVideoWithComfy(
  prompt: string,
  opts: { negative?: string; width?: number; height?: number; frames?: number } = {},
): Promise<{ data: Buffer; filename: string }> {
  const base = comfyUrl();
  // buildVideoWorkflow throws with a precise reason when the template is
  // missing, unreadable, or has an unfilled placeholder.
  const workflow = buildVideoWorkflow(prompt, opts);

  const queued = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: `direk-vid-${Date.now()}` }),
  });
  if (!queued.ok) {
    // ComfyUI puts the node-level reason (a bad checkpoint name, a missing
    // node) in the body; keep it so the failure is actionable.
    const detail = (await queued.text().catch(() => '')).slice(0, 300);
    throw new Error(`ComfyUI /prompt returned ${queued.status}${detail ? `: ${detail}` : ''}`);
  }
  const { prompt_id: promptId } = (await queued.json()) as { prompt_id?: string };
  if (!promptId) throw new Error('ComfyUI did not return a prompt_id');

  // Video takes longer than a still, so allow a generous ceiling.
  const image = await waitForImage(base, promptId, Math.max(timeoutMs(), 600000));
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  const view = await fetch(`${base}/view?${params}`);
  if (!view.ok) throw new Error(`ComfyUI /view returned ${view.status}`);
  return { data: Buffer.from(await view.arrayBuffer()), filename: image.filename };
}

/** Poll `/history/<id>` until the prompt finishes, then return its first image. */
async function waitForImage(base: string, promptId: string, limitMs: number): Promise<ComfyImageRef> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/history/${promptId}`);
    if (res.ok) {
      const history = (await res.json()) as Record<string, any>;
      const entry = history[promptId];
      const outputs = entry?.outputs;
      if (outputs) {
        for (const node of Object.values<any>(outputs)) {
          // Image nodes report `images`; video nodes (VHS_VideoCombine and
          // friends) report `gifs`, with the same shape.
          const first = node?.images?.[0] ?? node?.gifs?.[0];
          if (first?.filename) {
            return {
              filename: first.filename,
              subfolder: first.subfolder ?? '',
              type: first.type ?? 'output',
            };
          }
        }
      }
      if (entry?.status?.status_str === 'error') {
        throw new Error(`ComfyUI reported an execution error: ${describeHistoryError(entry)}`);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('ComfyUI timed out waiting for the image');
}

/**
 * Pull the human-readable reason out of a ComfyUI `/history` entry. ComfyUI
 * reports the failing node and message under `status.messages`; the exception
 * message is the useful part, with the node id as a fallback.
 */
function describeHistoryError(entry: any): string {
  const messages: any[] = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
  for (const message of messages) {
    if (message?.[0] === 'execution_error' && message[1]) {
      const { node_id: nodeId, node_type: nodeType, exception_message: text } = message[1];
      const where = nodeType ? `${nodeType}${nodeId ? ` #${nodeId}` : ''}` : nodeId;
      if (text) return where ? `${text} (${where})` : String(text);
    }
  }
  return 'walang detalye mula sa ComfyUI';
}
