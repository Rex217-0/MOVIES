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
  /**
   * Captioned images per genre, read off the `<slug>_<genre>_<NNN>` filename the
   * harvester writes. Files that carry no known genre land in `unclassified`
   * rather than being guessed into a bucket.
   */
  genres: Record<string, number>;
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/**
 * The genre tokens the harvester can write into a filename. Kept as a list here
 * rather than imported from the harvester so a stale dataset still classifies
 * after a genre is retired; anything unrecognised counts as unclassified.
 */
const GENRE_TOKENS = [
  'horror', 'comedy', 'action', 'scifi', 'love_story', 'thriller', 'anime', 'cartoons',
] as const;

/**
 * Read the genre out of a `<slug>_<genre>_<NNN>` stem.
 *
 * The harvester always writes the genre immediately before the zero-padded
 * index, so the genre is anchored there rather than searched anywhere in the
 * stem: a batch slug may itself contain a genre word (`horror_special_comedy_001`
 * is a comedy batch), and `love_story` contains an underscore, so the token
 * before the index is matched longest-first.
 */
export function genreOfStem(stem: string): string | null {
  const lower = stem.toLowerCase();
  const byLength = [...GENRE_TOKENS].sort((a, b) => b.length - a.length);
  for (const genre of byLength) {
    if (new RegExp(`_${genre}_\\d+$`).test(lower)) return genre;
  }
  return null;
}

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
  const genres: Record<string, number> = {};
  for (const stem of images) {
    if (!captions.has(stem)) continue;
    const genre = genreOfStem(stem) ?? 'unclassified';
    genres[genre] = (genres[genre] ?? 0) + 1;
  }
  return {
    triggerToken,
    dir,
    images: images.size,
    captions: captions.size,
    orphanCaptions: [...captions].filter(s => !images.has(s)).length,
    uncaptioned: [...images].filter(s => !captions.has(s)).length,
    ready: paired > 0,
    bytes,
    genres,
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
