/**
 * Wan 2.2 on the local ComfyUI (Server-2).
 *
 * The render engine already exists — `videoRenderService` drives it and
 * `comfyui.buildVideoWorkflow` fills the graph. What was missing was a way to
 * point the three Wan 2.2 model files somewhere else without editing JSON, and
 * a way to ask "is the graph actually loadable here?" before queueing a job and
 * waiting two minutes for a failure.
 *
 * So this module owns three things and nothing else: the model names (env
 * overridable), the workflow template path, and the pre-flight check that
 * compares the template against what ComfyUI reports in /object_info.
 */

import fs from 'node:fs';
import path from 'node:path';

export const WAN22_WORKFLOW_FILE = 'wan22_video_api.json';

export interface Wan22Models {
  unet: string;
  clip: string;
  vae: string;
}

/**
 * The three files the graph loads. Read from the environment so Server-2 can
 * swap a quantised or renamed weight without a code change; the defaults are the
 * exact names in `workflows/wan22_video_api.json`.
 */
export function wan22Models(): Wan22Models {
  return {
    unet: (process.env.COMFYUI_MODEL_WAN22 || 'wan2.2_ti2v_5B_fp16.safetensors').trim(),
    clip: (process.env.COMFYUI_CLIP_WAN22 || 'umt5_xxl_fp8_e4m3fn_scaled.safetensors').trim(),
    vae: (process.env.COMFYUI_VAE_WAN22 || 'wan2.2_vae.safetensors').trim(),
  };
}

/** Where the Wan 2.2 template lives. Overridable for a custom graph. */
export function wan22WorkflowPath(): string {
  if (process.env.COMFYUI_WORKFLOW_WAN22) return process.env.COMFYUI_WORKFLOW_WAN22;
  return path.join(process.cwd(), 'workflows', WAN22_WORKFLOW_FILE);
}

export function comfyBaseUrl(): string {
  return (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
}

/** Read the template as text. Throws with the path, so a missing file is obvious. */
export function readWan22Template(file = wan22WorkflowPath()): string {
  if (!fs.existsSync(file)) {
    throw new Error(`Walang Wan 2.2 workflow sa '${file}'.`);
  }
  return fs.readFileSync(file, 'utf8');
}

export interface ModelSubstitution {
  graph: Record<string, unknown>;
  /** Which loader node each model name was written into. */
  applied: { unet: boolean; clip: boolean; vae: boolean };
}

/**
 * Load the template and write the configured model names into the loader nodes.
 *
 * Done by walking the parsed graph rather than by string replacement: a model
 * name could contain `__` or a quote, and a text replace would also corrupt a
 * prompt that happens to mention one. The placeholders for prompt/seed/size are
 * left for `buildVideoWorkflow`, which owns those.
 */
export function loadWan22Graph(
  models: Wan22Models = wan22Models(),
  file = wan22WorkflowPath(),
): ModelSubstitution {
  const raw = readWan22Template(file);
  const graph = JSON.parse(raw) as Record<string, any>;
  const applied = { unet: false, clip: false, vae: false };

  for (const node of Object.values(graph)) {
    const classType = node?.class_type;
    const inputs = node?.inputs;
    if (!inputs) continue;
    if (classType === 'UNETLoader' && 'unet_name' in inputs) {
      inputs.unet_name = models.unet;
      applied.unet = true;
    } else if (classType === 'CLIPLoader' && 'clip_name' in inputs) {
      inputs.clip_name = models.clip;
      applied.clip = true;
    } else if (classType === 'VAELoader' && 'vae_name' in inputs) {
      inputs.vae_name = models.vae;
      applied.vae = true;
    }
  }

  const missing = (Object.keys(applied) as (keyof ModelSubstitution['applied'])[])
    .filter(key => !applied[key]);
  if (missing.length) {
    throw new Error(
      `Kulang ang loader node sa Wan 2.2 workflow: ${missing.join(', ')}. ` +
      'Kailangan ng UNETLoader, CLIPLoader at VAELoader sa API format.',
    );
  }
  return { graph, applied };
}

/** The names ComfyUI says it can load for one loader input, e.g. /object_info/UNETLoader. */
export async function comfyLoaderOptions(
  loader: 'UNETLoader' | 'CLIPLoader' | 'VAELoader',
  inputName: 'unet_name' | 'clip_name' | 'vae_name',
  baseUrl = comfyBaseUrl(),
): Promise<string[]> {
  const res = await fetch(`${baseUrl}/object_info/${loader}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sa /object_info/${loader}`);
  const info = (await res.json()) as Record<string, any>;
  const list = info?.[loader]?.input?.required?.[inputName]?.[0];
  return Array.isArray(list) ? list.map(String) : [];
}

export interface Wan22Status {
  ok: boolean;
  comfyUrl: string;
  workflow: string;
  workflowPresent: boolean;
  reachable: boolean;
  models: Wan22Models;
  /** Which configured model names ComfyUI cannot see. Empty when all three are there. */
  missingModels: string[];
  /** Human sentence, always filled. */
  note: string;
}

/**
 * Pre-flight check: is ComfyUI up, is the template there, and does ComfyUI
 * actually list the three Wan 2.2 files? A wrong filename is the most common
 * reason a render fails, and it is cheap to catch here.
 */
export async function checkWan22Status(opts: { baseUrl?: string; file?: string } = {}): Promise<Wan22Status> {
  // Trim trailing slashes here too: an operator pasting `http://host:8188/` into
  // a request must not turn into `//system_stats` and look like a dead server.
  const baseUrl = (opts.baseUrl || comfyBaseUrl()).replace(/\/+$/, '');
  const workflow = opts.file || wan22WorkflowPath();
  const models = wan22Models();
  const workflowPresent = fs.existsSync(workflow);

  const status: Wan22Status = {
    ok: false,
    comfyUrl: baseUrl,
    workflow,
    workflowPresent,
    reachable: false,
    models,
    missingModels: [],
    note: '',
  };

  if (!workflowPresent) {
    status.note = `Walang Wan 2.2 workflow sa ${workflow}.`;
    return status;
  }

  try {
    const res = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      status.note = `hindi maabot ang ComfyUI sa ${baseUrl} (HTTP ${res.status})`;
      return status;
    }
    status.reachable = true;
  } catch (error: any) {
    status.note = `hindi maabot ang ComfyUI sa ${baseUrl} (${error?.name === 'TimeoutError' ? 'timeout' : error?.message || error})`;
    return status;
  }

  // One loader failing to answer must not hide the others; collect what we can.
  const checks: [string, () => Promise<string[]>][] = [
    [models.unet, () => comfyLoaderOptions('UNETLoader', 'unet_name', baseUrl)],
    [models.clip, () => comfyLoaderOptions('CLIPLoader', 'clip_name', baseUrl)],
    [models.vae, () => comfyLoaderOptions('VAELoader', 'vae_name', baseUrl)],
  ];
  for (const [name, list] of checks) {
    try {
      const options = await list();
      if (!options.includes(name)) status.missingModels.push(name);
    } catch {
      status.missingModels.push(name);
    }
  }

  status.ok = status.missingModels.length === 0;
  status.note = status.ok
    ? `Wan 2.2 handa sa ${baseUrl}: ${models.unet}, ${models.clip}, ${models.vae}.`
    : `Hindi makita ng ComfyUI ang: ${status.missingModels.join(', ')}. Ilagay ang mga ito sa models/ ng ComfyUI.`;
  return status;
}
