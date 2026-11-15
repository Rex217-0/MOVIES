/**
 * Runtime settings for the local backends (ComfyUI, kohya).
 *
 * These point the app at the machine's ComfyUI server and kohya install. They
 * can be set as environment variables, but on a normal PC it is easier to keep
 * them in a JSON file next to the app and edit them once. The UI writes this
 * file for you, so there is nothing to hand-configure.
 *
 * Precedence: a real environment variable always wins over the file, so a
 * server deployment can still override everything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { comfyUrl } from './comfyui.ts';

export interface DirekSettings {
  /** ComfyUI base URL, e.g. http://127.0.0.1:8188 */
  comfyui_url?: string;
  /** Checkpoint for the built-in workflow. */
  comfyui_checkpoint?: string;
  /** Optional path to a custom ComfyUI workflow JSON template. */
  comfyui_workflow?: string;
  /** Optional path to a ComfyUI VIDEO workflow JSON template (AnimateDiff/SVD). */
  comfyui_video_workflow?: string;
  /** ComfyUI's models/loras folder, where trained LoRAs are published. */
  comfyui_loras_dir?: string;
  /** kohya_ss / sd-scripts checkout (must contain train_network.py). */
  kohya_dir?: string;
  /** Base model for training (path or HuggingFace id). */
  kohya_base_model?: string;
  /** Python interpreter for training. */
  kohya_python?: string;
  /** Launch training through `accelerate launch`. */
  kohya_accelerate?: boolean;
  /** Where training runs are written. */
  kohya_output_dir?: string;
  /** Local Ollama URL for the free text backend. */
  ollama_url?: string;
  /** Ollama model name, e.g. qwen2.5:7b. */
  ollama_model?: string;
  /** Piper executable for the offline backup voice (defaults to `piper`). */
  tts_piper_bin?: string;
  /** Piper voice model file (.onnx) used by the offline backup voice. */
  tts_piper_voice?: string;
  /** Fish Audio API key (cloud Tagalog voice, best quality). */
  fish_audio_api_key?: string;
  /** Fish Audio reference voice id, for a cloned voice. */
  fish_audio_reference_id?: string;
  /** Fish Audio model id (defaults to the provider default). */
  fish_audio_model?: string;
  /** Offline Tagalog model id (defaults to facebook/mms-tts-tgl). */
  tts_tagalog_model?: string;
}

/** Settings key -> environment variable. */
const ENV_MAP: Record<keyof DirekSettings, string> = {
  comfyui_url: 'COMFYUI_URL',
  comfyui_checkpoint: 'COMFYUI_CHECKPOINT',
  comfyui_workflow: 'COMFYUI_WORKFLOW',
  comfyui_video_workflow: 'COMFYUI_VIDEO_WORKFLOW',
  comfyui_loras_dir: 'COMFYUI_LORAS_DIR',
  kohya_dir: 'KOHYA_DIR',
  kohya_base_model: 'KOHYA_BASE_MODEL',
  kohya_python: 'KOHYA_PYTHON',
  kohya_accelerate: 'KOHYA_ACCELERATE',
  kohya_output_dir: 'KOHYA_OUTPUT_DIR',
  ollama_url: 'OLLAMA_URL',
  ollama_model: 'OLLAMA_MODEL',
  tts_piper_bin: 'TTS_PIPER_BIN',
  tts_piper_voice: 'TTS_PIPER_VOICE',
  fish_audio_api_key: 'FISH_AUDIO_API_KEY',
  fish_audio_reference_id: 'FISH_AUDIO_REFERENCE_ID',
  fish_audio_model: 'FISH_AUDIO_MODEL',
  tts_tagalog_model: 'TTS_TAGALOG_MODEL',
};

export function configPath(): string {
  return process.env.DIREK_CONFIG || path.join(process.cwd(), 'direk.config.json');
}

export function readSettings(): DirekSettings {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as DirekSettings) : {};
  } catch {
    return {};
  }
}

export function writeSettings(settings: DirekSettings): void {
  fs.writeFileSync(configPath(), JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/**
 * Apply settings to the process environment. An existing environment variable
 * wins unless `override` is set, which is what the UI uses for live updates.
 */
export function applySettings(settings: DirekSettings, override = false): void {
  for (const [key, env] of Object.entries(ENV_MAP)) {
    const value = settings[key as keyof DirekSettings];
    if (value === undefined || value === null || value === '') continue;
    if (!override && process.env[env]) continue;
    process.env[env] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  }
}

/** The settings currently in effect, and where each value came from. */
export function effectiveSettings(): { settings: DirekSettings; source: Record<string, 'env' | 'file' | 'default'> } {
  const file = readSettings();
  const settings: DirekSettings = {};
  const source: Record<string, 'env' | 'file' | 'default'> = {};

  for (const [key, env] of Object.entries(ENV_MAP)) {
    const k = key as keyof DirekSettings;
    if (process.env[env] !== undefined && process.env[env] !== '') {
      const raw = process.env[env] as string;
      (settings as any)[k] = k === 'kohya_accelerate' ? raw === '1' : raw;
      source[k] = 'env';
    } else if (file[k] !== undefined) {
      (settings as any)[k] = file[k];
      source[k] = 'file';
    } else {
      source[k] = 'default';
    }
  }
  return { settings, source };
}

/** Ask ComfyUI which models it can see (checkpoints, LoRAs). */
export async function comfyModelOptions(): Promise<{
  reachable: boolean;
  checkpoints: string[];
  loras: string[];
  error?: string;
}> {
  try {
    const res = await fetch(`${comfyUrl()}/object_info`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { reachable: false, checkpoints: [], loras: [], error: `ComfyUI returned ${res.status}` };
    const info = (await res.json()) as Record<string, any>;
    const opts = (node: string, field: string): string[] => {
      const spec = info?.[node]?.input?.required?.[field];
      const list = Array.isArray(spec) ? spec[0] : undefined;
      return Array.isArray(list) ? list.filter((v: unknown) => typeof v === 'string') : [];
    };
    return {
      reachable: true,
      checkpoints: opts('CheckpointLoaderSimple', 'ckpt_name'),
      loras: opts('LoraLoader', 'lora_name'),
    };
  } catch (error: any) {
    return { reachable: false, checkpoints: [], loras: [], error: error?.message || 'ComfyUI unreachable' };
  }
}
