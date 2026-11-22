#!/usr/bin/env node
/**
 * Generate a LoRA training dataset with a Gemini image model.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/gen_lora_dataset.mjs \
 *     --concept "10_clara" --count 20 \
 *     --subject "a 28-year-old Filipina woman, shoulder-length black hair" \
 *     --out "datasets"
 *
 * Writes <out>/<concept>/NN.png plus a matching NN.txt caption per image, which
 * is the layout kohya expects (repeats_trigger as the folder name).
 *
 * Nothing is faked: with no GEMINI_API_KEY the script stops and says so. It
 * never writes a placeholder image, because a dataset of blank files would
 * train a LoRA that produces blank frames.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

const MODEL = process.env.LORA_IMAGE_MODEL || 'nano-banana-pro-preview';
const IMAGE_SIZE = process.env.LORA_IMAGE_SIZE || '4K';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const concept = arg('concept');
const subject = arg('subject');
const outRoot = arg('out', 'datasets');
const count = Number(arg('count', '20'));

if (!concept || !subject) {
  console.error('Kailangan ang --concept at --subject. Tingnan ang header ng file.');
  process.exit(1);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(
    'Walang GEMINI_API_KEY. Hindi ito magre-render ng placeholder —\n' +
    'isang dataset ng blangkong file ay magtuturo sa LoRA na puro blangko ang ilabas.\n' +
    'I-set muna:  export GEMINI_API_KEY="..."',
  );
  process.exit(1);
}

/** Shot variety, so the LoRA learns the subject and not one framing. */
const SHOTS = [
  'medium shot, eye level, 50mm lens',
  'close-up portrait, 85mm lens, shallow depth of field',
  'full body, standing, natural pose',
  'three-quarter view, looking slightly away',
  'low angle, cinematic',
  'environmental portrait, subject off-centre',
  'profile view, soft window light',
  'waist-up, arms relaxed',
  'slight high angle, walking',
  'seated, hands visible, candid',
];

/** Lighting and grade variety, so lighting does not get baked into the LoRA. */
const LIGHT = [
  'golden hour backlight',
  'soft overcast daylight',
  'warm practical interior lighting',
  'cool blue twilight',
  'hard midday sun with crisp shadows',
  'diffused studio softbox',
  'neon night ambience',
  'candlelit warm interior',
];

const QUALITY =
  'ultra high definition, 4K, photorealistic, cinematic film still, ' +
  'sharp focus on the eyes, natural skin texture with visible pores, ' +
  'no watermark, no text, no logo, no distortion';

// ImageConfig has no negativePrompt field (only EditImageConfig,
// GenerateImagesConfig and GenerateVideosConfig do), so the avoid-list goes into
// the prompt text itself. Passing a negative_prompt key here would be ignored.
const NEGATIVE =
  'blurry, low quality, deformed hands, extra fingers, warped face, ' +
  'plastic skin, oversaturated, cartoon, anime, watermark, text';

function buildPrompt(i) {
  const shot = SHOTS[i % SHOTS.length];
  const light = LIGHT[i % LIGHT.length];
  const angle = i % 2 === 0 ? 'front view' : 'slight angle, not a passport photo';
  return `${subject}, ${shot}, ${angle}, ${light}, ${QUALITY}. Avoid: ${NEGATIVE}.`;
}

function caption(i) {
  const shot = SHOTS[i % SHOTS.length];
  const light = LIGHT[i % LIGHT.length];
  return `${concept.replace(/^\d+_/, '')}, ${shot}, ${light}`;
}

function extractImage(interaction) {
  const direct = interaction?.output_image?.data;
  if (direct) return Buffer.from(direct, 'base64');
  for (const step of interaction?.steps || []) {
    if (step?.type === 'model_output') {
      const found = step.content?.find((c) => c.type === 'image');
      if (found?.data) return Buffer.from(found.data, 'base64');
    }
  }
  return null;
}

const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
const dir = path.join(outRoot, concept);
fs.mkdirSync(dir, { recursive: true });

console.log(`Model: ${MODEL}  |  Image size: ${IMAGE_SIZE}  |  Concept: ${concept}`);
console.log(`Output: ${dir}  |  Count: ${count}\n`);

let ok = 0;
let failed = 0;

for (let i = 0; i < count; i++) {
  const n = String(i + 1).padStart(2, '0');
  const file = path.join(dir, `${n}.png`);
  if (fs.existsSync(file)) {
    console.log(`${n}  skip (nandiyan na)`);
    ok++;
    continue;
  }

  const prompt = buildPrompt(i);
  try {
    const interaction = await ai.interactions.create({
      model: MODEL,
      input: prompt,
      response_modalities: ['image'],
      generation_config: {
        image_config: { aspect_ratio: '2:3', image_size: IMAGE_SIZE },
      },
    });

    const data = extractImage(interaction);
    if (!data) throw new Error('walang image sa response');

    fs.writeFileSync(file, data);
    fs.writeFileSync(path.join(dir, `${n}.txt`), caption(i) + '\n');
    ok++;
    console.log(`${n}  ok  ${(data.length / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    failed++;
    console.error(`${n}  FAIL  ${err?.message || err}`);
  }
}

console.log(`\nTapos: ${ok} ok, ${failed} fail -> ${dir}`);
if (failed > 0) process.exitCode = 1;
