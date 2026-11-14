/**
 * Local render engine: real video and image work with ffmpeg, no cloud service.
 *
 * This is the free replacement for the paid connectors the skill registry used
 * to only name (Picsart for edits, OpusClip/Descript for clips and video edit).
 * Everything here runs on this machine and costs nothing.
 *
 * The binary comes from @ffmpeg-installer/ffmpeg, which ships a static build for
 * each platform, so there is nothing to install by hand. FFMPEG_PATH overrides
 * it when you want your own build.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Where the ffmpeg binary lives. */
export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require('@ffmpeg-installer/ffmpeg').path as string;
  } catch {
    return 'ffmpeg';
  }
}

/** A font for drawtext. We point at a real file so Tagalog text renders. */
export function fontPath(): string {
  const candidates = [
    process.env.FFMPEG_FONT,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/Library/Fonts/Arial.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return candidates[1];
}

export interface RenderOutput {
  data: Buffer;
  ext: string;
  mime: string;
}

const MP4: Pick<RenderOutput, 'ext' | 'mime'> = { ext: 'mp4', mime: 'video/mp4' };
const PNG: Pick<RenderOutput, 'ext' | 'mime'> = { ext: 'png', mime: 'image/png' };

function run(args: string[], timeoutMs = 20 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath(),
      args,
      { maxBuffer: 1 << 26, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr || error.message || '').trim().split('\n').slice(-4).join(' | ');
          reject(new Error(tail || 'ffmpeg failed'));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** ffmpeg prints its media report on stderr and then exits; read it there. */
function mediaReport(file: string): Promise<string> {
  return new Promise(resolve => {
    execFile(ffmpegPath(), ['-hide_banner', '-i', file], (_e, _o, stderr) =>
      resolve(String(stderr || '')),
    );
  });
}

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** Duration, size and audio presence, parsed from ffmpeg's own report. */
export async function probe(file: string): Promise<MediaInfo> {
  const text = await mediaReport(file);
  const clock = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const duration = clock
    ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + parseFloat(clock[3])
    : 0;
  const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text);
  return {
    duration,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    hasAudio: /Stream #\d+:\d+.*Audio:/.test(text),
  };
}

/** Is a usable ffmpeg present? */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(['-version'], 15000);
    return true;
  } catch {
    return false;
  }
}

function workDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'direk-render-'));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a stray temp dir is not worth failing the request */
  }
}

async function readResult(file: string, kind: typeof MP4 | typeof PNG): Promise<RenderOutput> {
  const data = fs.readFileSync(file);
  if (!data.length) throw new Error('ffmpeg produced an empty file');
  return { data, ...kind };
}

/** True when the buffer already carries the PNG signature. */
export function isPng(data: Buffer): boolean {
  return (
    data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
  );
}

/**
 * Re-encode any image ffmpeg can read into a real PNG.
 *
 * The free Pollinations backend answers with a JPEG whatever the URL asks for,
 * and a JPEG saved under a `.png` name trains a LoRA badly (and some loaders
 * reject it outright), so every hosted image goes through here before it is
 * stored or zipped. A buffer that is already PNG is returned untouched.
 */
export async function toPng(data: Buffer): Promise<Buffer> {
  if (isPng(data)) return data;
  const dir = workDir();
  try {
    const inFile = path.join(dir, 'in.img');
    const outFile = path.join(dir, 'out.png');
    fs.writeFileSync(inFile, data);
    await run(['-y', '-loglevel', 'error', '-i', inFile, outFile], 60000);
    const png = fs.readFileSync(outFile);
    if (!isPng(png)) throw new Error('ffmpeg did not produce a PNG');
    return png;
  } finally {
    cleanup(dir);
  }
}

/** Write text to a file so drawtext never has to escape it. */
function textFile(dir: string, text: string): string {
  const file = path.join(dir, 'text.txt');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

/** Cut a clip down to a window. `start` in seconds, `duration` optional. */
export async function trimVideo(input: string, start: number, duration?: number): Promise<RenderOutput> {
  const dir = workDir();
  try {
    const out = path.join(dir, 'out.mp4');
    const args = ['-y', '-ss', String(Math.max(0, start)), '-i', input];
    if (duration && duration > 0) args.push('-t', String(duration));
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', out);
    await run(args);
    return await readResult(out, MP4);
  } finally {
    cleanup(dir);
  }
}

/** Scale a clip, keeping the frame. */
export async function scaleVideo(input: string, width: number, height: number): Promise<RenderOutput> {
  const dir = workDir();
  try {
    const out = path.join(dir, 'out.mp4');
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    await run(['-y', '-i', input, '-vf', vf, ...ENCODE, '-c:a', 'copy', out]);
    return await readResult(out, MP4);
  } finally {
    cleanup(dir);
  }
}

/** Crop a clip to a 9:16 vertical frame, for Reels, Shorts and TikTok. */
export async function toVertical(input: string, width = 1080, height = 1920): Promise<RenderOutput> {
  const dir = workDir();
  try {
    const out = path.join(dir, 'out.mp4');
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    await run(['-y', '-i', input, '-vf', vf, ...ENCODE, '-c:a', 'copy', out]);
    return await readResult(out, MP4);
  } finally {
    cleanup(dir);
  }
}

/** Re-encode one clip to a common frame so several can be joined. */
async function normalize(input: string, dir: string, index: number, width: number, height: number, fps: number): Promise<string> {
  const info = await probe(input);
  const out = path.join(dir, `norm${index}.mp4`);
  const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
  const args = ['-y', '-i', input];
  if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-shortest');
  args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', out);
  await run(args);
  return out;
}

/** Join several clips into one, normalising the frame first. */
export async function concatVideos(inputs: string[], width = 1280, height = 720): Promise<RenderOutput> {
  if (inputs.length < 2) throw new Error('Kailangan ng dalawa o higit pang clip para pagsamahin.');
  const dir = workDir();
  try {
    const clips: string[] = [];
    for (let i = 0; i < inputs.length; i++) clips.push(await normalize(inputs[i], dir, i, width, height, 30));
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, clips.map(c => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const out = path.join(dir, 'out.mp4');
    await run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
    return await readResult(out, MP4);
  } finally {
    cleanup(dir);
  }
}

/**
 * Join clips with the concat demuxer and `-c copy`, so the video and audio are
 * copied through instead of re-encoded. This is how the factory stitches the 18
 * approved scenes into one feature: it is fast, and it loses no quality.
 *
 * `-c copy` only works when the clips share codec, size, frame rate and audio
 * layout. `renderFeatureScene` guarantees that; if a mismatch is found anyway,
 * the caller gets the ffmpeg error rather than a silently broken film.
 */
export async function concatCopy(inputs: string[], dir?: string): Promise<RenderOutput> {
  if (inputs.length < 2) throw new Error('Kailangan ng dalawa o higit pang clip para pagsamahin.');
  const work = dir ?? workDir();
  const ownsDir = !dir;
  try {
    const list = path.join(work, 'concat-list.txt');
    fs.writeFileSync(list, inputs.map(c => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const out = path.join(work, 'feature.mp4');
    await run(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    return await readResult(out, MP4);
  } finally {
    if (ownsDir) cleanup(work);
  }
}

/** Turn one still into a moving shot with a slow zoom, a ken-burns clip. */
export async function kenBurnsClip(image: string, seconds = 3, width = 1280, height = 720): Promise<string> {
  const dir = workDir();
  const out = path.join(dir, 'kb.mp4');
  const frames = Math.round(seconds * 30);
  const vf =
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},` +
    `zoompan=z='min(zoom+0.0012,1.4)':d=${frames}:s=${width}x${height}:fps=30,format=yuv420p`;
  await run(['-y', '-loop', '1', '-i', image, '-t', String(seconds), '-vf', vf, ...ENCODE, out]);
  return out;
}

/**
 * Build a video from stills: each image becomes a ken-burns shot, then they are
 * joined. This is how a storyboard or a photo set becomes a free clip.
 */
export async function imageToVideo(
  images: string[],
  opts: { secondsPerImage?: number; width?: number; height?: number } = {},
): Promise<RenderOutput> {
  if (!images.length) throw new Error('Kailangan ng kahit isang larawan.');
  const seconds = opts.secondsPerImage ?? 3;
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const dir = workDir();
  try {
    const clips: string[] = [];
    for (const image of images) clips.push(await kenBurnsClip(image, seconds, width, height));
    if (clips.length === 1) return await readResult(clips[0], MP4);
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, clips.map(c => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const out = path.join(dir, 'out.mp4');
    await run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
    return await readResult(out, MP4);
  } finally {
    cleanup(dir);
  }
}

export type GradePreset = 'warm' | 'cool' | 'cinematic' | 'vivid' | 'bw' | 'faded';

const GRADES: Record<GradePreset, string> = {
  warm: 'colorbalance=rs=0.12:gs=0.04:bs=-0.10,eq=saturation=1.06',
  cool: 'colorbalance=rs=-0.08:bs=0.14,eq=saturation=1.04',
  cinematic: 'colorbalance=rs=0.10:bs=-0.08:rm=-0.04:bm=0.06,eq=contrast=1.12:saturation=1.05',
  vivid: 'eq=saturation=1.35:contrast=1.1',
  bw: 'hue=s=0,eq=contrast=1.15',
  faded: 'eq=saturation=0.85:brightness=0.03,curves=all=0/0.08 1/0.92',
};

/** Apply a film look to a clip. */
export async function colorGrade(input: string, preset: GradePreset): Promise<RenderOutput> {
  const filter = GRADES[preset];
  if (!filter) throw new Error(`Walang grade na '${preset}'.`);
  const dir = workDir();
  try {
    const out = path.join(dir, 'out.mp4');
    await run(['-y', '-i', input, '-vf', filter, ...ENCODE, '-c:a', 'copy', out]);
    return await readResult(out, MP4);
  } finally {
    cleanup(dir);
  }
}

export type TextPlacement = 'top' | 'center' | 'bottom';

const Y_EXPR: Record<TextPlacement, string> = {
  top: 'h*0.08',
  center: '(h-text_h)/2',
  bottom: 'h-text_h-h*0.08',
};

/** Burn a title or caption onto a clip. */
export async function addText(
  input: string,
  text: string,
  opts: { placement?: TextPlacement; fontSize?: number } = {},
): Promise<RenderOutput> {
  const dir = workDir();
  try {
    const file = textFile(dir, text);
    const out = path.join(dir, 'out.mp4');
    const y = Y_EXPR[opts.placement ?? 'bottom'];
    const size = opts.fontSize ?? 48;
    const draw =
      `drawtext=textfile='${file.replace(/'/g, "'\\''")}':fontfile='${fontPath().replace(/'/g, "'\\''")}':` +
      `fontcolor=white:fontsize=${size}:line_spacing=10:box=1:boxcolor=black@0.45:boxborderw=18:` +
      `x=(w-text_w)/2:y=${y}`;
    await run(['-y', '-i', input, '-vf', draw, ...ENCODE, '-c:a', 'copy', out]);
    return await readResult(out, MP4);
  } finally {
    cleanup(dir);
  }
}

/** Grab one frame as a thumbnail. */
export async function thumbnail(input: string, atSeconds = 0): Promise<RenderOutput> {
  const dir = workDir();
  try {
    const out = path.join(dir, 'out.png');
    await run(['-y', '-ss', String(Math.max(0, atSeconds)), '-i', input, '-frames:v', '1', out]);
    return await readResult(out, PNG);
  } finally {
    cleanup(dir);
  }
}

/**
 * Make a poster or thumbnail image from a title. With a background image the
 * title is burned over it; without one a solid cinematic card is drawn.
 */
export async function poster(
  title: string,
  opts: { subtitle?: string; background?: string; width?: number; height?: number } = {},
): Promise<RenderOutput> {
  const dir = workDir();
  try {
    const width = opts.width ?? 1280;
    const height = opts.height ?? 720;
    const titleFile = textFile(dir, title);
    const draw = (file: string, size: number, y: string, color: string) =>
      `drawtext=textfile='${file.replace(/'/g, "'\\''")}':fontfile='${fontPath().replace(/'/g, "'\\''")}':` +
      `fontcolor=${color}:fontsize=${size}:line_spacing=12:box=1:boxcolor=black@0.5:boxborderw=22:x=(w-text_w)/2:y=${y}`;

    const filters: string[] = [];
    if (opts.subtitle) {
      const subFile = textFile(dir, opts.subtitle);
      filters.push(draw(subFile, Math.round(width / 28), 'h*0.68', 'white'));
    }
    filters.push(draw(titleFile, Math.round(width / 16), 'h*0.36', 'white'));

    const out = path.join(dir, 'out.png');
    const args = opts.background
      ? ['-y', '-i', opts.background, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},${filters.join(',')}`, '-frames:v', '1', out]
      : ['-y', '-f', 'lavfi', '-i', `color=c=0x0b1220:s=${width}x${height}`, '-vf', filters.join(','), '-frames:v', '1', out];
    await run(args);
    return await readResult(out, PNG);
  } finally {
    cleanup(dir);
  }
}

/** Strip audio, e.g. for a silent background loop. */
export async function muteVideo(input: string): Promise<RenderOutput> {
  const dir = workDir();
  try {
    const out = path.join(dir, 'out.mp4');
    await run(['-y', '-i', input, '-an', '-c:v', 'copy', out]);
    return await readResult(out, MP4);
  } finally {
    cleanup(dir);
  }
}
