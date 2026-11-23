/**
 * The strict real-video guard, part one: what ComfyUI actually has installed.
 *
 * The render chain has free failovers. When ComfyUI is offline or a Wan 2.2
 * weight is missing it quietly drops to the free motion engine (a still image
 * with an ffmpeg ken-burns pan) or, in the older film path, to a procedural
 * colour gradient. Both are honest in the logs, but the bytes they produce are
 * not a real video render, and they land in the Render Vault looking like one.
 *
 * `STRICT_REAL_VIDEO_ONLY=true` turns those failovers off for the local-first
 * engine: if ComfyUI cannot render with the Wan 2.2 weights, the request fails
 * naming the exact missing dependency, and nothing is written to the vault.
 *
 * This module deliberately imports nothing from the render service, so the
 * render service can import it without a cycle.
 */
import { comfyUrl } from './comfyui.ts';

/** The three Wan 2.2 files a real local video render needs, and what loads each. */
export const WAN22_WEIGHTS = [
  {
    file: 'wan2.2_ti2v_5B_fp16.safetensors',
    node: 'UNETLoader',
    input: 'unet_name',
    role: 'diffusion model',
  },
  {
    file: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    node: 'CLIPLoader',
    input: 'clip_name',
    role: 'text encoder',
  },
  {
    file: 'wan2.2_vae.safetensors',
    node: 'VAELoader',
    input: 'vae_name',
    role: 'VAE',
  },
] as const;

export interface Wan22WeightReport {
  /** False when ComfyUI could not be asked, so absence proves nothing. */
  checked: boolean;
  reachable: boolean;
  /** The exact filenames ComfyUI does not list. Empty when nothing is missing. */
  missing: string[];
  /** What each missing file is for, so the message says why it matters. */
  missingDetail: string[];
  detail: string;
}

/**
 * Compare the model lists ComfyUI advertises on `/object_info` with the Wan 2.2
 * files. This asks the server that will actually run the graph instead of
 * trusting a path written in `.env`.
 */
export async function wan22WeightReport(): Promise<Wan22WeightReport> {
  const base = comfyUrl();
  let info: any;
  try {
    const res = await fetch(`${base}/object_info`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      return {
        checked: false, reachable: false, missing: [], missingDetail: [],
        detail: `Hindi maabot ang /object_info ng ComfyUI sa ${base} (HTTP ${res.status}).`,
      };
    }
    info = await res.json();
  } catch (error: any) {
    return {
      checked: false, reachable: false, missing: [], missingDetail: [],
      detail: `Hindi maabot ang ComfyUI sa ${base}: ${error?.message || error}.`,
    };
  }

  const namesFor = (node: string, input: string): string[] | null => {
    const spec = info?.[node]?.input?.[input];
    // ComfyUI encodes a combo as [["a","b"], {...}], so the first entry is the list.
    const list = Array.isArray(spec) ? spec[0] : null;
    return Array.isArray(list) ? list.map(String) : null;
  };

  const missing: string[] = [];
  const missingDetail: string[] = [];
  for (const weight of WAN22_WEIGHTS) {
    const names = namesFor(weight.node, weight.input);
    // A node the server lacks is not a missing file; the graph itself will fail
    // and the ComfyUI diagnosis already explains that case.
    if (names === null) continue;
    if (!names.includes(weight.file)) {
      missing.push(weight.file);
      missingDetail.push(`${weight.file} (${weight.role}, ${weight.node}.${weight.input})`);
    }
  }

  return {
    checked: true,
    reachable: true,
    missing,
    missingDetail,
    detail: missing.length
      ? `Kulang ang Wan 2.2 weights sa ComfyUI: ${missingDetail.join('; ')}.`
      : 'Kumpleto ang Wan 2.2 weights sa ComfyUI.',
  };
}

/**
 * The strict switch. An explicit value always wins; otherwise it follows the
 * engine, because `comfyui` is the only mode that promises a local GPU render
 * and therefore the only one where a silent downgrade misleads.
 */
export function strictRealVideoOnly(preferredEngine: string): boolean {
  const raw = (process.env.STRICT_REAL_VIDEO_ONLY || '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  return preferredEngine === 'comfyui';
}

/**
 * One coherent refusal: why the attempt failed, then the exact weights that are
 * absent. Two guesses joined would read like two separate problems.
 */
export async function strictRefusalDetail(cause: string): Promise<{ detail: string; missing: string[] }> {
  const report = await wan22WeightReport();
  const parts: string[] = [];
  if (cause) parts.push(cause.replace(/\.$/, ''));
  parts.push(report.detail);
  parts.push(
    'STRICT_REAL_VIDEO_ONLY ay naka-on, kaya walang fallback clip na gagawin. ' +
      'I-download ang weights sa ComfyUI/models, o i-set ang STRICT_REAL_VIDEO_ONLY=false ' +
      'kung sadyang gusto ang libreng motion engine.',
  );
  return { detail: parts.join(' '), missing: report.missing };
}
