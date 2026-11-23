#!/usr/bin/env node
/**
 * Write the `direk_scifi_neon` starter captions into lora_runs/.
 *
 * The captions themselves live in src/extensions/season01/starterDataset.ts, so
 * the boot path and this script cannot drift apart. Safe to re-run: existing
 * captions are left untouched.
 *
 * Usage:
 *   node --import tsx scripts/seed-lora-dataset.mjs
 *   node --import tsx scripts/seed-lora-dataset.mjs --dir /path/to/lora_runs
 */
import path from 'node:path';
import { seedDataset, TRIGGER } from '../src/extensions/season01/starterDataset.ts';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = arg('dir', path.join(process.cwd(), 'lora_runs'));
const { dir, written } = seedDataset(root);
console.log(`Dataset: ${dir}`);
console.log(written.length ? `Wrote ${written.length} captions: ${written.join(', ')}` : 'All captions already there.');
console.log(`Drop your 4 PNGs as ${TRIGGER}_001.png .. ${TRIGGER}_004.png, or run the harvester.`);
