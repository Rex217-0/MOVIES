/**
 * Read every `lora_runs/<trigger>/dataset` folder off disk, so LoRA Studio can show what is already
 * harvested instead of asking the user to remember.
 *
 * A dataset is counted by the images that are really there. A caption without an
 * image trains nothing, so it is reported separately rather than inflating the
 * sample count.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface DatasetInfo {
  triggerToken: string;
  dir: string;
  /** Images kohya will actually train on. */
  images: number;
  /** Caption files present. */
  captions: number;
  /** Captions with no matching image. */
  orphanCaptions: number;
  /** Images with no caption; kohya will skip these. */
  uncaptioned: number;
  /** Ready only when there is at least one captioned image. */
  ready: boolean;
  bytes: number;
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/** The stems of a folder's images and captions, so they can be matched up. */
function stems(dir: string): { images: Set<string>; captions: Set<string> } {
  const images = new Set<string>();
  const captions = new Set<string>();
  for (const entry of fs.readdirSync(dir)) {
    const stem = entry.replace(/\.[^.]+$/, '');
    if (IMAGE_RE.test(entry)) images.add(stem);
    else if (/\.txt$/i.test(entry)) captions.add(stem);
  }
  return { images, captions };
}

export function readDataset(triggerToken: string, dir: string): DatasetInfo {
  const { images, captions } = stems(dir);
  let bytes = 0;
  for (const stem of images) {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.replace(/\.[^.]+$/, '') === stem && IMAGE_RE.test(entry)) {
        bytes += fs.statSync(path.join(dir, entry)).size;
      }
    }
  }
  let paired = 0;
  for (const stem of images) if (captions.has(stem)) paired += 1;
  return {
    triggerToken,
    dir,
    images: images.size,
    captions: captions.size,
    orphanCaptions: [...captions].filter(s => !images.has(s)).length,
    uncaptioned: [...images].filter(s => !captions.has(s)).length,
    ready: paired > 0,
    bytes,
  };
}

/** Every dataset under `runsRoot`, newest trigger name last. Missing root is empty. */
export function listDatasets(runsRoot: string): DatasetInfo[] {
  if (!fs.existsSync(runsRoot)) return [];
  const out: DatasetInfo[] = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsRoot, entry.name, 'dataset');
    if (!fs.existsSync(dir)) continue;
    out.push(readDataset(entry.name, dir));
  }
  return out.sort((a, b) => a.triggerToken.localeCompare(b.triggerToken));
}
