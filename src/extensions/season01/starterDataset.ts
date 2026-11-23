/**
 * The `direk_scifi_neon` starter dataset.
 *
 * `lora_runs/` is gitignored, so the starter captions cannot be committed as
 * files. They live here instead and are written into place on boot. Seeding is
 * idempotent: an existing caption is never overwritten, so a caption edited by
 * hand survives.
 *
 * Captions only. The images are the user's four Pexels Sci-Fi Neon PNGs; a
 * placeholder image would train a LoRA on blank frames, so none is created.
 */

import fs from 'node:fs';
import path from 'node:path';

export const TRIGGER = 'direk_scifi_neon';

/** The four starter captions, kept in the order the images are numbered. */
export const STARTER_CAPTIONS = [
  'direk_scifi_neon, close-up portrait of a woman with short blonde hair wearing dark reflective futuristic visor sunglasses, black leather jacket, cybernetic facial line markings, vibrant neon green and magenta rim lighting, dark blurred background, 35mm cinematic film',
  'direk_scifi_neon, medium portrait of a woman looking up at a glowing white circular holographic HUD interface, hand reaching out to touch virtual controls, dramatic studio rim lighting, dark background, realistic sci-fi cinema',
  'direk_scifi_neon, medium shot of a woman wearing a white VR headset and white sleeveless futuristic jacket, both hands raised interacting with virtual space, moody cyan and purple neon lighting, minimalist studio backdrop',
  'direk_scifi_neon, side profile of a woman seated in a sleek futuristic control chair looking up at a large glowing blue star map screen, dark spaceship cockpit with red accent underglow, atmospheric sci-fi cinematography',
];


/**
 * Write any missing captions under `<rootDir>/<TRIGGER>/dataset`.
 * Returns the file names actually written, so callers report fact, not intent.
 */
export function seedDataset(rootDir: string): { dir: string; written: string[] } {
  const dir = path.join(rootDir, TRIGGER, 'dataset');
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  STARTER_CAPTIONS.forEach((caption, i) => {
    const name = `${TRIGGER}_${String(i + 1).padStart(3, '0')}.txt`;
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return;
    fs.writeFileSync(file, caption + '\n', 'utf8');
    written.push(name);
  });
  return { dir, written };
}
