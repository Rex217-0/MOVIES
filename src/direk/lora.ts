/**
 * LoRA training-set builder for Direk.
 *
 * Given a brief and a character bible, it turns the production plan into the
 * artifacts an image/video LoRA actually needs:
 *
 *   dataset/<trigger>_<NNN>.txt   one caption per training sample
 *   dataset/README.md             what the set is and how to use it
 *   kohya_config.toml             a ready-to-edit kohya_ss config
 *   dataset_info.json             kohya-ss/sd-scripts style metadata
 *
 * The captions are written in the style LoRA trainers expect: a trigger token
 * first, then a comma-separated, most-important-first description. Image files
 * themselves are produced by the visual pipeline, not here — this module writes
 * the text half, which is the half that is usually wrong.
 */

import { createZip, type ZipEntry } from './zip.ts';

export interface LoraSample {
  /** Slug used for the caption file name. */
  slug: string;
  /** Where in the film this sample comes from, e.g. "SHOT_LIST · eksena 1". */
  stage: string;
  /** The prompt that will generate the image or video frame. */
  prompt: string;
}

export interface LoraCharacter {
  name: string;
  /** Physical description reused across every sample for consistency. */
  look?: string;
  wardrobe?: string;
  voice?: string;
}

export interface LoraBrief {
  title: string;
  genre: string;
  mood: string;
  durationMinutes?: number;
  trigger: string;
  character: LoraCharacter;
  samples: LoraSample[];
  /** Base model this LoRA targets. */
  baseModel?: string;
  /** Real market notes from the box-office dataset, if available. */
  marketNote?: string;
}

export interface LoraArtifact {
  filename: string;
  content: string;
}

const DEFAULT_BASE = 'stabilityai/stable-diffusion-xl-base-1.0';

/** Sanitise a free-text string into a safe, lower_snake token. */
export function toSlug(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'sample';
}

/** Validate a LoRA trigger token: lowercase letters, digits and underscores. */
export function isValidTrigger(trigger: string): boolean {
  return /^[a-z][a-z0-9_]{2,39}$/.test(trigger || '');
}

export function numberedName(trigger: string, index: number): string {
  return `${trigger}_${String(index + 1).padStart(3, '0')}`;
}

/**
 * Build the caption for one sample: the trigger token, then the character's
 * fixed look (for consistency), then the shot-specific description.
 */
export function buildCaption(brief: LoraBrief, sample: LoraSample): string {
  const parts: string[] = [brief.trigger];
  const { character } = brief;
  if (character.look) parts.push(character.look);
  if (character.wardrobe) parts.push(`suot ${character.wardrobe}`);
  parts.push(sample.prompt);
  return parts
    .map(p => p.trim())
    .filter(Boolean)
    .join(', ');
}

/** Produce every text artifact of the LoRA set, ready to zip or download. */
export function buildLoraArtifacts(brief: LoraBrief): LoraArtifact[] {
  if (!isValidTrigger(brief.trigger)) {
    throw new Error(
      `Invalid trigger token '${brief.trigger}'. Use lowercase letters, digits and underscores (3-40 chars).`,
    );
  }
  if (!brief.samples.length) {
    throw new Error('A LoRA set needs at least one sample.');
  }

  const base = brief.baseModel || DEFAULT_BASE;
  const artifacts: LoraArtifact[] = [];

  brief.samples.forEach((sample, i) => {
    const name = numberedName(brief.trigger, i);
    const caption = buildCaption(brief, sample);
    artifacts.push({ filename: `dataset/${name}.txt`, content: `${caption}\n` });
    // A sidecar prompt file, so the exact generation prompt is recoverable.
    artifacts.push({
      filename: `dataset/${name}.prompt.json`,
      content:
        JSON.stringify(
          { stage: sample.stage, trigger: brief.trigger, prompt: sample.prompt, caption },
          null,
          2,
        ) + '\n',
    });
  });

  artifacts.push({ filename: 'kohya_config.toml', content: kohyaConfig(brief, base) });
  artifacts.push({ filename: 'dataset_info.json', content: datasetInfo(brief, base) });
  artifacts.push({ filename: 'dataset/README.md', content: datasetReadme(brief, base) });
  return artifacts;
}

/** Cap on images generated per set, to bound time and cost. */
export const MAX_LORA_IMAGES = 20;

export interface LoraZipOptions {
  /** Generated PNGs, keyed by sample name (e.g. `direk_x_001`). */
  images?: Map<string, Buffer>;
  /** Sample names whose image generation failed. */
  skipped?: string[];
  /** Why no images were produced, when that is the case. */
  imageNote?: string;
  when?: Date;
}

/**
 * Package the whole set as a store-only ZIP for download.
 *
 * Text artifacts are always included. When `options.images` is given, the
 * matching PNGs are added under `dataset/<name>.png` and an `IMAGES.md`
 * manifest records what was generated and what was skipped.
 */
export function buildLoraZip(brief: LoraBrief, options: LoraZipOptions = {}): Buffer {
  const entries: ZipEntry[] = buildLoraArtifacts(brief).map(a => ({
    name: a.filename,
    data: Buffer.from(a.content, 'utf8'),
  }));

  const images = options.images;
  if (images && images.size > 0) {
    brief.samples.forEach((_sample, i) => {
      const name = numberedName(brief.trigger, i);
      const png = images.get(name);
      if (png) entries.push({ name: `dataset/${name}.png`, data: png });
    });
    entries.push({
      name: 'dataset/IMAGES.md',
      data: Buffer.from(imageManifest(brief, images, options.skipped ?? [], options.imageNote), 'utf8'),
    });
  } else if (options.imageNote) {
    entries.push({
      name: 'dataset/IMAGES.md',
      data: Buffer.from(imageManifest(brief, new Map(), [], options.imageNote), 'utf8'),
    });
  }

  return createZip(entries, options.when ?? new Date());
}

function imageManifest(
  brief: LoraBrief,
  images: Map<string, Buffer>,
  skipped: string[],
  note?: string,
): string {
  const lines = [
    `# Images — ${brief.title}`,
    '',
    `Trigger: \`${brief.trigger}\``,
    '',
  ];
  if (images.size) {
    lines.push(`Generated: **${images.size}** of ${brief.samples.length} samples.`, '');
    for (const [name, buf] of images) {
      lines.push(`- \`dataset/${name}.png\` (${Math.round(buf.length / 1024)} KB)`);
    }
  } else {
    lines.push('Walang larawan sa set na ito.');
  }
  if (skipped.length) {
    lines.push('', `Hindi nagawa: ${skipped.map(s => `\`${s}\``).join(', ')}.`);
  }
  if (note) lines.push('', `**Tandaan:** ${note}`);
  lines.push(
    '',
    `Ang mga larawan ay dapat pangalanan katulad ng caption: \`${brief.trigger}_001.png\` +`,
    `\`${brief.trigger}_001.txt\`, para mahanap ng trainer.`,
  );
  return lines.join('\n') + '\n';
}

function kohyaConfig(brief: LoraBrief, base: string): string {
  const dir = toSlug(brief.title);
  return `# kohya_ss LoRA config generated by Direk (MOVIE CREATOR)
# Base model: ${base}
# Trigger token: ${brief.trigger}
# Edit the paths below, then run: accelerate launch train_network.py --config_file kohya_config.toml

[general]
enable_bucket = true
bucket_no_upscale = false

[[datasets]]
resolution = 1024
batch_size = 1
enable_bucket = true

  [[datasets.subsets]]
  image_dir = "dataset"
  caption_extension = ".txt"
  num_repeats = 10
  # Files are named ${brief.trigger}_001.png / .txt, so the token is learned
  # from the caption, not the filename.

[network_arguments]
network_module = "networks.lora"
network_dim = 32
network_alpha = 16

[optimizer_arguments]
learning_rate = 1e-4
optimizer_type = "AdamW8bit"
lr_scheduler = "cosine_with_restarts"
lr_scheduler_num_cycles = 3

[training_arguments]
max_train_epochs = 10
save_every_n_epochs = 2
mixed_precision = "fp16"
save_model_as = "safetensors"
output_dir = "output/${dir}"
output_name = "${dir}_${brief.trigger}"
seed = 42

[logging_arguments]
logging_dir = "logs"
log_with = "tensorboard"
`;
}

function datasetInfo(brief: LoraBrief, base: string): string {
  const dir = toSlug(brief.title);
  return (
    JSON.stringify(
      {
        _comment: `LoRA dataset metadata for "${brief.title}", generated by Direk.`,
        base_model: base,
        trigger_token: brief.trigger,
        num_images: brief.samples.length,
        num_repeats: 10,
        output_name: `${dir}_${brief.trigger}`,
        genre: brief.genre,
        mood: brief.mood,
        character: brief.character.name,
        captions: brief.samples.map((s, i) => ({
          file: `${numberedName(brief.trigger, i)}.txt`,
          stage: s.stage,
          text: buildCaption(brief, s),
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

function datasetReadme(brief: LoraBrief, base: string): string {
  const dir = toSlug(brief.title);
  const market = brief.marketNote ? `\n**Market note:** ${brief.marketNote}\n` : '';
  return `# LoRA training set — ${brief.title}

Generated by **Direk** (MOVIE CREATOR). Trigger token: \`${brief.trigger}\`.
${market}
## Ano ito

Isang text-side LoRA set: ang mga caption at config para sa ${brief.samples.length}
training samples. Ang mga larawan mismo ay galing sa visual pipeline
(shot list + image/video prompts), hindi dito.

| File | Gamit |
| --- | --- |
| \`dataset/${brief.trigger}_NNN.txt\` | caption ng bawat sample (trigger token una) |
| \`dataset/${brief.trigger}_NNN.prompt.json\` | ang eksaktong generation prompt |
| \`kohya_config.toml\` | kohya_ss config, handa nang i-edit |
| \`dataset_info.json\` | metadata (kohya-ss / sd-scripts style) |

## Paano gamitin

1. Ilagay ang mga larawan sa \`dataset/\` kasama ng \`.txt\` captions, pangalan
   na katulad ng caption: \`${brief.trigger}_001.png\` + \`${brief.trigger}_001.txt\`.
2. I-edit ang paths sa \`kohya_config.toml\` (base model, output dir).
3. Patakbuhin ang kohya_ss / sd-scripts training.

Base model na target: \`${base}\`.

## Karakter

- **${brief.character.name}**${brief.character.look ? ` — ${brief.character.look}` : ''}
${brief.character.wardrobe ? `- Suot: ${brief.character.wardrobe}\n` : ''}${brief.character.voice ? `- Boses: ${brief.character.voice}\n` : ''}
## Mga sample

${brief.samples.map((s, i) => `${i + 1}. **${s.stage}** — \`${buildCaption(brief, s)}\``).join('\n')}

## Tandaan

Ang trigger token na \`${brief.trigger}\` ay ilalagay sa prompt para tawagin
ang LoRA. Huwag baguhin ang token sa captions at sa prompt nang sabay.
`;
}
