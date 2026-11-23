#!/usr/bin/env node
/**
 * Fetch the Wan 2.2 TI2V 5B weights that workflows/wan22_video_api.json loads.
 *
 * The three files live in Comfy-Org/Wan-2.2 (not Wan-AI/Wan2.2-TI2V-5B, which
 * ships .pth weights ComfyUI cannot load). Each goes to the folder the matching
 * loader node reads from, because UNETLoader only lists models/diffusion_models
 * and CLIPLoader only lists models/text_encoders.
 *
 *   node scripts/fetch_wan22_models.mjs --check
 *   node scripts/fetch_wan22_models.mjs --dir C:\ComfyUI
 *
 * Downloads resume from a .part file, so a dropped connection costs only the
 * bytes still missing rather than the whole 9.3 GB shard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'Comfy-Org/Wan-2.2';
const BASE = `https://huggingface.co/${REPO}/resolve/main`;

/** Sizes are pinned so a truncated download fails the check instead of loading garbage. */
const FILES = [
  {
    folder: 'diffusion_models',
    name: 'wan2.2_ti2v_5B_fp16.safetensors',
    remote: 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
    bytes: 9_999_658_848,
  },
  {
    folder: 'text_encoders',
    name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    remote: 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    bytes: 6_735_906_897,
  },
  {
    folder: 'vae',
    name: 'wan2.2_vae.safetensors',
    remote: 'split_files/vae/wan2.2_vae.safetensors',
    bytes: 1_409_400_960,
  },
];

function parseArgs(argv) {
  const args = { check: false, dir: process.env.COMFYUI_DIR || '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--dir') args.dir = argv[++i] || '';
  }
  return args;
}

function target(root, file) {
  return path.join(root, 'models', file.folder, file.name);
}

function gb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function scan(root) {
  return FILES.map(file => {
    const dest = target(root, file);
    const present = fs.existsSync(dest);
    const actual = present ? fs.statSync(dest).size : 0;
    return { file, dest, present, actual, ok: present && actual === file.bytes };
  });
}

async function remoteSize(file) {
  const res = await fetch(`${BASE}/${file.remote}`, { method: 'HEAD', redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} sa ${file.name}`);
  return Number(res.headers.get('content-length') || 0);
}

async function download(file, dest) {
  const part = `${dest}.part`;
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const total = await remoteSize(file);

  if (have === total && total > 0) {
    fs.renameSync(part, dest);
    console.log(`  ${file.name}: natapos na, inilipat`);
    return;
  }
  if (have > total) {
    fs.rmSync(part, { force: true });
    have = 0;
  }

  const headers = {};
  if (have > 0) headers.Range = `bytes=${have}-`;

  const res = await fetch(`${BASE}/${file.remote}`, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} sa ${file.name}`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });

  let seen = have;
  let lastPct = -5;
  const started = Date.now();
  const body = Readable.fromWeb(res.body);
  body.on('data', chunk => {
    seen += chunk.length;
    const pct = Math.floor((seen / total) * 100);
    if (pct >= lastPct + 5) {
      lastPct = pct;
      const mbps = (seen - have) / 1024 ** 2 / ((Date.now() - started) / 1000 || 1);
      process.stdout.write(`\r  ${file.name}: ${pct}% (${gb(seen)} / ${gb(total)}, ${mbps.toFixed(1)} MB/s)`);
    }
  });

  await pipeline(body, out);
  process.stdout.write('\n');

  const finalSize = fs.statSync(part).size;
  if (finalSize !== total) {
    throw new Error(
      `Kulang ang ${file.name}: ${finalSize} bytes, inaasahan ${total}. ` +
        `Patakbuhin muli para magpatuloy sa ${path.basename(part)}.`,
    );
  }
  fs.renameSync(part, dest);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Kailangan ang ComfyUI folder. Halimbawa:');
    console.error('  node scripts/fetch_wan22_models.mjs --dir C:\\ComfyUI');
    process.exit(2);
  }
  const root = path.resolve(args.dir);
  console.log(`ComfyUI: ${root}`);
  console.log(`Source:  https://huggingface.co/${REPO}\n`);

  if (args.check) {
    let missing = 0;
    for (const row of scan(root)) {
      const state = row.ok
        ? 'OK'
        : row.present
          ? `MALI ANG LAKI (${row.actual} bytes)`
          : 'WALA';
      if (!row.ok) missing++;
      console.log(`  [${state}] models/${row.file.folder}/${row.file.name}`);
    }
    const total = FILES.reduce((n, f) => n + f.bytes, 0);
    console.log(`\n  Kabuuan: ${gb(total)}`);
    if (missing) {
      console.log(`  Kulang: ${missing} file. Patakbuhin nang walang --check para i-download.`);
      process.exit(1);
    }
    console.log('  Kumpleto. Puwede nang patakbuhin ang wan22_video_api.json.');
    return;
  }

  for (const file of FILES) {
    const dest = target(root, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size === file.bytes) {
      console.log(`  ${file.name}: nandiyan na, nilalaktawan`);
      continue;
    }
    console.log(`  ${file.name}: dinodownload...`);
    await download(file, dest);
    console.log(`  ${file.name}: OK -> models/${file.folder}/${file.name}`);
  }
  console.log('\n  Tapos. I-set ang COMFYUI_CHECKPOINT=wan2.2_ti2v_5B_fp16.safetensors');
}

main().catch(err => {
  console.error(`\n  FAILED: ${err.message}`);
  process.exit(1);
});
