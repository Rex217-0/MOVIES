/**
 * Movie Creator: turn a one-line brief into a real, downloadable short film.
 *
 * Everything here runs locally with ffmpeg except the two things that need a
 * model: the screenplay (a text model) and the narration. Narration tries, in
 * order, Fish Audio (best Tagalog, needs a key), the cloud voice, Meta's offline
 * Tagalog voice (free, CPU, real Tagalog) and Piper. The pictures are drawn
 * procedurally from the scene's mood, so no image model and no ComfyUI are
 * required for a movie to come out. When ComfyUI *is* running the shots use its
 * images instead.
 *
 * The output is a normal MP4 with narration, a music bed, titles and credits,
 * saved into the asset store so it can be downloaded from the UI.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { GoogleGenAI } from '@google/genai';
import { ffmpegPath, fontPath, filterPath, probe, concatVideos } from './render.ts';
import { defaultPython } from './platform.ts';
import { saveAsset, type AssetMeta } from './assets.ts';
import { MOODS, MOOD_LABELS, TTS_VOICES, type Mood, type MovieOptions, type TtsVoice, sceneCount } from '../movieMeta.ts';
import {
  renderVideo, VideoBackendUnavailable,
  videoRenderReady as videoBackendReady, videoRenderDetail as videoBackendDetail,
} from './videoRenderService.ts';
import type { SceneStage } from './factory.ts';
import { buildVeoStylePrompt, buildVeoStyleNegative } from '../tactical/rules.ts';

export {
  VideoBackendUnavailable, videoRenderReady as videoBackendReady,
  videoRenderDetail as videoBackendDetail,
} from './videoRenderService.ts';

export { MOODS, MOOD_LABELS, TTS_VOICES, type Mood, type MovieOptions, type TtsVoice, sceneCount };

export const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

const FPS = 30;
const WIDTH = 1280;
const HEIGHT = 720;
const MAX_SCENE_SECONDS = 40;

/** A voice-over line longer than this is clipped: one shot cannot hold more. */
export const MAX_NARRATION_WORDS = 70;

function ff(args: string[], timeoutMs = 30 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { maxBuffer: 1 << 26, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const tail = String(stderr || error.message || '').trim().split('\n').slice(-3).join(' | ');
        reject(new Error(tail || 'ffmpeg failed'));
        return;
      }
      resolve(String(stdout));
    });
  });
}

function workDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'direk-movie-'));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a stray temp dir is not worth failing a render over */
  }
}

// ---------------------------------------------------------------------------
// Screenplay
// ---------------------------------------------------------------------------

export interface MovieScene {
  heading: string;
  narration: string;
  visual: string;
  mood: Mood;
}

export interface MovieScript {
  title: string;
  logline: string;
  scenes: MovieScene[];
}

export function scriptPrompt(brief: string, opts: MovieOptions, grounding = ''): string {
  const scenes = sceneCount(opts.minutes);
  const lines = [
    `Ikaw si Movie Robo, isang direktor ng pelikula. Gumawa ng screenplay sa JSON.`,
    `Brief: ${brief}`,
    `Haba: ${opts.minutes} minuto. Bilang ng eksena: ${scenes}.`,
    opts.mood ? `Mood: ${opts.mood}.` : `Pumili ng mood na bagay sa brief.`,
  ];
  // Grounding from the real datasets: reference titles, market share, pacing.
  if (grounding.trim()) lines.push('', grounding);
  lines.push(
    ``,
    `Sumagot lamang ng JSON na ganito ang hugis:`,
    `{"title":"...","logline":"...","scenes":[{"heading":"SCENE 1 — LUGAR, ORAS","narration":"...","visual":"...","mood":"warm"}]}`,
    ``,
    `Mga tuntunin:`,
    `- Isang pangungusap lamang ang logline.`,
    `- Ang "narration" ay Tagalog na voice-over, 30 hanggang 45 salita, para sa isang eksena.`,
    `- Ang "visual" ay maikling paglalarawan ng shot sa Ingles, 8 hanggang 16 salita.`,
    `- Ang "mood" ay isa sa: ${MOODS.join(', ')}.`,
    `- Walang markdown, walang paliwanag, JSON lang.`,
  );
  return lines.join('\n');
}

/** Pull the screenplay out of a model reply that may carry prose or fences. */
export function parseScript(raw: string): MovieScript | null {
  if (!raw) return null;
  const sliced = sliceJson(raw);
  if (!sliced) return null;

  // A full parse first; when the reply was cut off mid-array, salvage what
  // arrived rather than throwing the whole screenplay away.
  let payload: any = null;
  try {
    payload = JSON.parse(sliced);
  } catch {
    payload = salvage(sliced);
  }
  if (!payload) return null;

  const rawScenes = Array.isArray(payload.scenes) ? payload.scenes : [];
  const scenes: MovieScene[] = [];
  for (const scene of rawScenes) {
    const narration = clipWords(String(scene?.narration ?? ''), MAX_NARRATION_WORDS);
    if (!narration) continue;
    const mood = String(scene?.mood ?? '').trim().toLowerCase();
    scenes.push({
      heading: String(scene?.heading ?? `SCENE ${scenes.length + 1}`).trim(),
      narration,
      visual: clipWords(String(scene?.visual ?? narration).trim(), 40),
      mood: (MOODS as string[]).includes(mood) ? (mood as Mood) : 'warm',
    });
  }
  if (!scenes.length) return null;
  return {
    title: String(payload?.title ?? 'Walang Pamagat').trim() || 'Walang Pamagat',
    logline: clipWords(String(payload?.logline ?? '').trim(), 40),
    scenes,
  };
}

/** Keep a narration line short enough to read in one shot. */
function clipWords(text: string, max: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(' ');
  const clipped = words.slice(0, max).join(' ');
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}…`;
}

/** The outermost JSON object in a reply, fences and prose removed. */
function sliceJson(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const end = raw.lastIndexOf('}');
  if (end > start) return raw.slice(start, end + 1);
  return raw.slice(start);
}

/**
 * Recover a truncated screenplay: close the arrays and objects that the model
 * never got to finish, then drop the last (partial) scene.
 */
function salvage(text: string): any | null {
  let body = text.trimEnd();
  const lastClose = body.lastIndexOf('}');
  if (lastClose > 0) body = body.slice(0, lastClose + 1);
  body = body.replace(/,\s*$/, '');
  for (const suffix of ['}', ']}', '}]}']) {
    try {
      const candidate = JSON.parse(body + suffix);
      if (candidate?.scenes) return candidate;
    } catch {
      /* try the next closing shape */
    }
  }
  // Last resort: pick the scene objects out with a regex.
  const scenes: any[] = [];
  const re = /\{[^{}]*"narration"\s*:\s*"(?:[^"\\]|\\.)*"[^{}]*\}/g;
  for (const match of body.matchAll(re)) {
    try {
      scenes.push(JSON.parse(match[0]));
    } catch {
      /* skip a malformed scene */
    }
  }
  if (!scenes.length) return null;
  const title = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? 'Walang Pamagat';
  const logline = /"logline"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? '';
  return { title, logline, scenes };
}

/**
 * A screenplay that needs no model at all: the brief is cut into beats and each
 * beat becomes a shot. This is the safety net so a movie still comes out when
 * no text backend is configured.
 */
export function fallbackScript(brief: string, opts: MovieOptions): MovieScript {
  const words = (brief || 'isang pelikula').trim().split(/\s+/);
  const moods: Mood[] = ['warm', 'tense', 'dreamy', 'cold', 'grim', 'hopeful'];
  const beats = [
    'Nagbubukas ang kuwento. Ipinapakilala ang mundo at ang pangunahing tauhan.',
    'May bagay na hindi inaasahan. Nababago ang takbo ng kuwento.',
    'Lumalalim ang problema. Kailangang magpasya ng tauhan.',
    'Ang pinakamahirap na sandali. Dito nasusubok ang lahat.',
    'Narating ang tugatog. Isang pagpili ang gagawin.',
    'Ang pagwawakas. May natutunan, may naiwan.',
  ];
  const count = sceneCount(opts.minutes);
  const scenes: MovieScene[] = [];
  for (let i = 0; i < count; i++) {
    const beat = beats[Math.floor((i / count) * beats.length)];
    scenes.push({
      heading: `SCENE ${i + 1}`,
      narration: `${beat} Sa eksenang ito, ${words.slice(0, 8).join(' ')} ang gabay ng kuwento.`,
      visual: `cinematic shot ${i + 1} of ${words.slice(0, 6).join(' ')}`,
      mood: opts.mood ?? moods[i % moods.length],
    });
  }
  return { title: opts.title || 'Isang Maikling Pelikula', logline: brief, scenes };
}

/** Scale a scene's mood onto the palette table. */
export function moodPalette(mood: Mood): { base: [number, number, number]; amp: [number, number, number]; accent: string } {
  const table: Record<Mood, { base: [number, number, number]; amp: [number, number, number]; accent: string }> = {
    warm: { base: [58, 28, 16], amp: [120, 84, 40], accent: '0xffda2a' },
    cold: { base: [14, 28, 52], amp: [46, 92, 150], accent: '0x9fd8ff' },
    tense: { base: [44, 12, 14], amp: [150, 40, 40], accent: '0xff5a4a' },
    dreamy: { base: [40, 26, 62], amp: [120, 96, 170], accent: '0xd9b8ff' },
    grim: { base: [18, 18, 20], amp: [70, 70, 78], accent: '0xbfc4cc' },
    hopeful: { base: [22, 40, 34], amp: [90, 170, 120], accent: '0x9dffc4' },
  };
  return table[mood];
}

// ---------------------------------------------------------------------------
// Narration (Gemini TTS)
// ---------------------------------------------------------------------------

/** Wrap raw PCM in a WAV container so ffmpeg reads it as audio. */
export function wavFromPcm(pcm: Buffer, sampleRate = 24000, channels = 1, bits = 16): Buffer {
  const byteRate = (sampleRate * channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Read the rate out of `audio/L16;codec=pcm;rate=24000`. */
export function parsePcmRate(mime: string | undefined, fallback = 24000): number {
  const m = /rate=(\d+)/.exec(mime || '');
  return m ? Number(m[1]) : fallback;
}

export function ttsConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY) && process.env.TTS_DISABLE !== '1';
}

let ttsClient: GoogleGenAI | null = null;

/** Errors worth waiting out: rate limits and transient capacity. */
function retryableTts(message: string): boolean {
  const m = (message || '').toLowerCase();
  return m.includes('429') || m.includes('503') || m.includes('quota') || m.includes('high demand') || m.includes('overloaded') || m.includes('resource_exhausted') || m.includes('unavailable');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The Gemini TTS line. This is the best-sounding voice, but the free tier caps
 * it per day, so callers fall through to the offline voice when it refuses.
 */
async function geminiSpeech(text: string, voice: TtsVoice): Promise<Buffer> {
  if (!process.env.GEMINI_API_KEY) throw new Error('Kailangan ng GEMINI_API_KEY para sa boses.');
  if (!ttsClient) ttsClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: 'v1beta' });

  let lastError: any = null;
  for (const wait of [0, 4000, 12000]) {
    if (wait) await sleep(wait);
    try {
      const res = await ttsClient.models.generateContent({
        model: TTS_MODEL,
        contents: text,
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
      const data = part?.inlineData?.data;
      if (!data) throw new Error('Walang audio na ibinalik ang TTS.');
      return wavFromPcm(Buffer.from(data, 'base64'), parsePcmRate(part?.inlineData?.mimeType));
    } catch (error: any) {
      lastError = error;
      if (!retryableTts(error?.message || '')) break;
    }
  }
  throw new Error(lastError?.message || 'TTS failed');
}

// ---------------------------------------------------------------------------
// Fish Audio (cloud, real Tagalog and voice cloning)
//
// Fish Audio is the best-sounding Tagalog voice: it is trained on Filipino and
// can clone a reference voice from a `reference_id`. It needs an API key, so it
// is optional; when the key is absent the offline Tagalog voice takes over.
// ---------------------------------------------------------------------------

const FISH_API = process.env.FISH_AUDIO_API_URL || 'https://api.fish.audio';

export function fishConfigured(): boolean {
  // A reference voice id is optional: Fish Audio uses a default voice when it
  // is absent. Only the API key is required.
  return Boolean(process.env.FISH_AUDIO_API_KEY) && process.env.FISH_AUDIO_DISABLE !== '1';
}

/** One line of narration from Fish Audio, as a WAV. */
export async function fishSpeech(text: string): Promise<Buffer> {
  if (!process.env.FISH_AUDIO_API_KEY) throw new Error('Kailangan ng FISH_AUDIO_API_KEY.');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const body: Record<string, unknown> = {
    text,
    format: 'wav',
    latency: process.env.FISH_AUDIO_LATENCY || 'normal',
  };
  if (process.env.FISH_AUDIO_REFERENCE_ID) body.reference_id = process.env.FISH_AUDIO_REFERENCE_ID;
  if (process.env.FISH_AUDIO_MODEL) body.model = process.env.FISH_AUDIO_MODEL;

  let lastError: any = null;
  for (const wait of [0, 4000, 12000]) {
    if (wait) await sleep(wait);
    try {
      const res = await fetch(`${FISH_API}/v1/tts`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const error: any = new Error(`Fish Audio ${res.status}: ${detail.slice(0, 200)}`);
        if (res.status === 429 || res.status >= 500) {
          lastError = error;
          continue;
        }
        throw error;
      }
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length < 256) throw new Error('Walang audio na ibinalik ang Fish Audio.');
      return audio;
    } catch (error: any) {
      lastError = error;
      if (!retryableTts(error?.message || '')) throw error;
    }
  }
  throw lastError || new Error('Fish Audio failed');
}

// ---------------------------------------------------------------------------
// Offline Tagalog voice (Meta MMS VITS)
//
// Meta's MMS text-to-speech is a small VITS model with a Filipino (Tagalog)
// checkpoint. It runs on the CPU several times faster than real time, needs no
// key and no network once cached, and speaks actual Tagalog — unlike Piper, which
// only has English voices and reads Tagalog with English phonemes.
// ---------------------------------------------------------------------------

export type NarrationSource = 'fish' | 'gemini' | 'tagalog' | 'piper' | 'none';

const TAGALOG_VOICES: Record<string, string> = {
  tagalog: 'facebook/mms-tts-tgl',
  filipino: 'facebook/mms-tts-tgl',
};

/** The Tagalog model id, when the offline Tagalog voice is usable. */
export function tagalogVoice(): string | null {
  if (process.env.TTS_TAGALOG_DISABLE === '1') return null;
  const script = process.env.TTS_TAGALOG_SCRIPT || path.join(process.cwd(), 'scripts', 'tagalog_tts.py');
  if (!fs.existsSync(script)) return null;
  return TAGALOG_VOICES[(process.env.TTS_TAGALOG_MODEL || 'tagalog').toLowerCase()] || process.env.TTS_TAGALOG_MODEL!;
}

/** The Piper binary and voice file, when one is configured and present. */
export function piperCommand(): { bin: string; voice: string } | null {
  const bin = process.env.TTS_PIPER_BIN || 'piper';
  const voice = process.env.TTS_PIPER_VOICE;
  if (!voice) return null;
  if (!fs.existsSync(voice)) return null;
  return { bin, voice };
}

// Once a cloud voice reports a quota error it will keep reporting it for the
// rest of the day, so remember that and go straight to the offline voice for
// the remaining lines instead of paying the retry delay on every one.
let cloudExhausted = false;

/** Forget the cloud-voice circuit breaker; called at the start of a render. */
export function resetNarration(): void {
  cloudExhausted = false;
}

/** One line of narration from the offline Tagalog voice. */
export async function tagalogSpeech(text: string): Promise<Buffer> {
  const model = tagalogVoice();
  if (!model) throw new Error('Walang available na offline na Tagalog na boses.');
  const python = process.env.TTS_PYTHON || defaultPython();
  const script = process.env.TTS_TAGALOG_SCRIPT || path.join(process.cwd(), 'scripts', 'tagalog_tts.py');
  const out = path.join(os.tmpdir(), `direk-tgl-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        python,
        [script, out],
        { maxBuffer: 1 << 24, timeout: 600000, env: { ...process.env, TTS_TAGALOG_MODEL: model } },
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(honestTtsError(python, stderr, error.message || 'tagalog tts failed')));
            return;
          }
          resolve();
        },
      );
      child.stdin?.end(text);
    });
    return fs.readFileSync(out);
  } finally {
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* the temp file is disposable */
    }
  }
}

/**
 * A voice that cannot run because its Python stack is missing must say so
 * plainly. A bare `ModuleNotFoundError: torch` buries the real fix, which is to
 * install the packages into the interpreter named by `TTS_PYTHON`.
 */
export function honestTtsError(python: string, stderr: string, fallback: string): string {
  const detail = String(stderr || fallback).trim().split('\n').slice(-1)[0];
  if (/ModuleNotFoundError|ImportError|No module named/i.test(detail)) {
    return `${detail} — patakbuhin ang '${python} -m pip install transformers torch soundfile' ` +
      `para sa offline na Tagalog na boses`;
  }
  return detail;
}

/** One line of narration from the offline voice. */
export async function piperSpeech(text: string): Promise<Buffer> {
  const cmd = piperCommand();
  if (!cmd) throw new Error('Walang naka-configure na offline na boses.');
  const out = path.join(os.tmpdir(), `direk-piper-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(cmd.bin, ['--model', cmd.voice, '--output_file', out], { maxBuffer: 1 << 24, timeout: 120000 }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || 'piper failed').trim().split('\n').slice(-1)[0]));
          return;
        }
        resolve();
      });
      child.stdin?.end(text);
    });
    return fs.readFileSync(out);
  } finally {
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* the temp file is disposable */
    }
  }
}

export interface NarrationLine {
  buffer: Buffer;
  source: NarrationSource;
}

/** The voices that can actually be tried, in the order they are tried. */
const KNOWN_VOICES: NarrationSource[] = ['fish', 'tagalog', 'piper', 'gemini'];

/**
 * The narration fallback order.
 *
 * Fish Audio comes first: it is the best-sounding Tagalog voice and can clone a
 * reference voice, but it needs a key, so it is optional. The offline Tagalog
 * voice is next (free, real Tagalog, no quota); Piper is the last real voice
 * because it only has English phonemes. When none of them answers the shot
 * carries the line as a burned-in caption instead.
 *
 * `TTS_ORDER=fish,piper,captions` overrides this when a deployment wants the
 * plain Fish → Piper → captions chain and nothing else.
 */
export function narrationOrder(): NarrationSource[] {
  const raw = process.env.TTS_ORDER;
  if (raw) {
    const parsed = raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter((s): s is NarrationSource => (KNOWN_VOICES as string[]).includes(s));
    if (parsed.length) return parsed;
  }
  return ['fish', 'tagalog', 'gemini', 'piper'];
}

/** Whether a voice in the order can actually speak right now. */
export function voiceReady(source: NarrationSource): boolean {
  if (source === 'fish') return fishConfigured();
  if (source === 'tagalog') return Boolean(tagalogVoice());
  if (source === 'piper') return Boolean(piperCommand());
  if (source === 'gemini') return ttsConfigured();
  return false;
}

/** The voices that are ready, in the configured order. */
export function narrationBackendOrder(): NarrationSource[] {
  return narrationOrder().filter(voiceReady);
}

/** Speak one line with one named voice. Throws when that voice cannot. */
async function speakWith(source: NarrationSource, text: string, voice: TtsVoice): Promise<Buffer> {
  if (source === 'fish') return fishSpeech(text);
  if (source === 'tagalog') return tagalogSpeech(text);
  if (source === 'piper') return piperSpeech(text);
  if (source === 'gemini') return geminiSpeech(text, voice);
  throw new Error(`Walang boses na '${source}'.`);
}

/**
 * Narration for one line, from the first voice that answers. The order is
 * `narrationOrder()` (Fish Audio, then the offline Tagalog voice, then the cloud
 * voice, then Piper). Returns null when none works, and the shot then carries
 * the line as a caption instead.
 */
export async function narrate(text: string, voice: TtsVoice = 'Kore'): Promise<NarrationLine | null> {
  for (const source of narrationOrder()) {
    if (!voiceReady(source)) continue;
    if (source === 'gemini' && cloudExhausted) continue;
    try {
      return { buffer: await speakWith(source, text, voice), source };
    } catch (error: any) {
      if (source !== 'piper' && retryableTts(error?.message || '')) cloudExhausted = true;
    }
  }
  return null;
}

/** The voices the app can use, for the status endpoint. */
export function narrationBackends(): {
  fish: boolean;
  cloud: boolean;
  tagalog: boolean;
  offline: boolean;
  piper_voice?: string;
  tagalog_model?: string;
  tagalog_python?: string;
  order: NarrationSource[];
} {
  const cmd = piperCommand();
  return {
    fish: fishConfigured(),
    cloud: ttsConfigured(),
    tagalog: Boolean(tagalogVoice()),
    offline: Boolean(cmd),
    piper_voice: cmd?.voice,
    tagalog_model: tagalogVoice() || undefined,
    tagalog_python: process.env.TTS_PYTHON || defaultPython(),
    order: narrationBackendOrder(),
  };
}

// ---------------------------------------------------------------------------
// Pictures (procedural, no model needed)
// ---------------------------------------------------------------------------

/** A drifting multi-colour gradient, drawn from the scene's mood. */
function gradientExpr(mood: Mood, period: number): string {
  const { base, amp } = moodPalette(mood);
  const wave = (offset: number, speed: number) =>
    `0.5+0.5*sin(2*PI*(X/${WIDTH}*0.6+Y/${HEIGHT}*0.3+T/${period}+${offset}))`;
  const wave2 = (offset: number) =>
    `0.5+0.5*sin(2*PI*((X+Y)/${WIDTH + HEIGHT}*1.4-T/${period * 0.7}+${offset}))`;
  const ch = (i: number) =>
    `${base[i]}+${amp[i]}*(0.6*${wave(0.1 * i, period)}+0.4*${wave2(0.25 * i)})`;
  return `geq=r='${ch(0)}':g='${ch(1)}':b='${ch(2)}'`;
}

/** Draw one still at double size so the zoom stays sharp. */
async function backdrop(dir: string, mood: Mood, index: number): Promise<string> {
  const file = path.join(dir, `bg${index}.png`);
  await ff([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=${WIDTH * 2}x${HEIGHT * 2}:d=1:r=${FPS}`,
    '-vf', gradientExpr(mood, 9 + index),
    '-frames:v', '1', file,
  ]);
  return file;
}

function drawtext(text: string, opts: { size: number; y: string; color: string; from: number; to: number }): string {
  const file = path.join(os.tmpdir(), `direk-txt-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  const alpha = `if(lt(t,${opts.from}+1),t-${opts.from},if(lt(t,${opts.to}),1,0))`;
  return (
    `drawtext=textfile='${filterPath(file)}':fontfile='${filterPath(fontPath())}':fontcolor=${opts.color}:fontsize=${opts.size}:` +
    `line_spacing=12:box=1:boxcolor=black@0.42:boxborderw=20:x=(w-text_w)/2:y=${opts.y}:` +
    `alpha='${alpha}':enable='between(t,${opts.from},${opts.to})'`
  );
}

/** Wrap a long line so a caption never runs off the frame. */
export function wrapText(text: string, maxChars = 46): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4).join('\n');
}

/**
 * One shot: the mood backdrop with a slow push-in, a grade, grain, a vignette,
 * the scene heading fading in, and the narration shown as a caption so the
 * story reads even when the voice is unavailable.
 */
export async function renderShot(
  scene: MovieScene,
  index: number,
  dir: string,
  seconds: number,
  opts: { caption?: boolean } = {},
): Promise<string> {
  const still = await backdrop(dir, scene.mood, index);
  const out = path.join(dir, `shot${index}.mp4`);
  const frames = Math.max(1, Math.round(seconds * FPS));
  const filters = [
    `scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH * 2}:${HEIGHT * 2}`,
    `zoompan=z='min(zoom+0.00035,1.22)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    'format=yuv420p',
    'colorbalance=rs=0.06:bs=-0.04,eq=contrast=1.12:saturation=1.06',
    'noise=alls=5:allf=t',
    'vignette=PI/4.6',
    drawtext(scene.heading, { size: 30, y: 'h*0.09', color: 'white', from: 0.6, to: Math.min(5.6, seconds) }),
  ];
  if (opts.caption) {
    filters.push(drawtext(wrapText(scene.narration), { size: 26, y: 'h-text_h-h*0.07', color: 'white', from: 0.8, to: seconds }));
  }
  await ff(['-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', still, '-t', String(seconds), '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', out]);
  return out;
}

/** A title or credit card: a still with text, no push-in. */
export async function renderCard(
  lines: { text: string; size: number; color: string }[],
  seconds: number,
  mood: Mood,
  dir: string,
  name: string,
): Promise<string> {
  const still = await backdrop(dir, mood, 99);
  const out = path.join(dir, `${name}.mp4`);
  const filters = lines.map((line, i) =>
    drawtext(line.text, { size: line.size, y: `${0.28 + i * 0.14}*h`, color: line.color, from: 0.4, to: seconds + 5 }),
  );
  const vf = [
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH}:${HEIGHT}`,
    'format=yuv420p',
    'eq=contrast=1.1:saturation=1.04',
    'vignette=PI/4.4',
    ...filters,
  ].join(',');
  await ff(['-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', still, '-t', String(seconds), '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', out]);
  return out;
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

/** A slow, quiet pad so the film is never silent between lines. */
export async function musicBed(seconds: number, mood: Mood, dir: string): Promise<string> {
  const chords: Record<Mood, number[]> = {
    warm: [146.83, 185.0, 220.0],
    cold: [130.81, 155.56, 196.0],
    tense: [110.0, 116.54, 164.81],
    dreamy: [174.61, 220.0, 261.63],
    grim: [98.0, 116.54, 146.83],
    hopeful: [164.81, 207.65, 246.94],
  };
  const notes = chords[mood];
  const expr = notes
    .map((f, i) => `0.09*sin(2*PI*${f}*t)*sin(2*PI*0.05*t+${i})`)
    .join('+');
  const out = path.join(dir, 'music.wav');
  await ff([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=${seconds}`,
    '-af', 'lowpass=f=1200,volume=0.7',
    '-c:a', 'pcm_s16le', out,
  ]);
  return out;
}

/** Put narration on a silent shot, then pad the shot out to its full length. */
async function muxNarration(shot: string, narration: string | null, seconds: number, dir: string, name: string): Promise<string> {
  const out = path.join(dir, `${name}.mp4`);
  if (!narration) {
    await ff([
      '-y', '-hide_banner', '-loglevel', 'error', '-i', shot,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-shortest', '-c:v', 'copy', '-c:a', 'aac', out,
    ]);
    return out;
  }
  await ff([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', shot, '-i', narration,
    '-filter_complex', `[1:a]adelay=900|900,apad,atrim=0:${seconds}[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-t', String(seconds), out,
  ]);
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface MovieProgress {
  stage: string;
  percent: number;
  detail?: string;
}

export type ProgressFn = (p: MovieProgress) => void;

export interface SceneRenderResult {
  data: Buffer;
  seconds: number;
  voiced: boolean;
  voiceSource: NarrationSource;
}

/**
 * Normalise a generated clip to the film's fixed format (1280x720, 30fps, stereo
 * AAC), then extend it to the full scene length by looping the encoded clip and
 * copying it (`-c copy`), so the long scene is never re-encoded. Every scene
 * then carries the same codec, size and audio layout, so the whole picture
 * joins with `ffmpeg -c copy`.
 */
async function normaliseShot(clip: string, dir: string, seconds: number): Promise<string> {
  const info = await probe(clip);
  const vf = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS},format=yuv420p`;
  const norm = path.join(dir, 'shot-normalised.mp4');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', clip];
  if (info.hasAudio) {
    args.push('-vf', vf, '-c:a', 'aac', '-ar', '44100', '-ac', '2');
  } else {
    args.push(
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-shortest',
      '-vf', vf, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    );
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', norm);
  await ff(args);
  const out = path.join(dir, 'shot.mp4');
  await ff([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-stream_loop', '-1', '-i', norm, '-t', String(seconds), '-c', 'copy', out,
  ]);
  return out;
}

/**
 * Put the narration and the music bed onto the shot in one pass, keeping the
 * video untouched (`-c:v copy`). The narration sits under the shot's own silent
 * track, delayed so it does not start on the first frame.
 */
async function mixScene(shot: string, narration: string | null, bed: string, seconds: number, out: string): Promise<void> {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', shot];
  let filter: string;
  if (narration) {
    args.push('-i', narration, '-i', bed);
    filter =
      `[1:a]adelay=900|900,apad,atrim=0:${seconds}[v];` +
      `[2:a]volume=0.12[m];[0:a][v][m]amix=inputs=3:duration=first[a]`;
  } else {
    args.push('-i', bed);
    filter = `[1:a]volume=0.12[m];[0:a][m]amix=inputs=2:duration=first[a]`;
  }
  args.push(
    '-filter_complex', filter, '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', out,
  );
  await ff(args);
}

/**
 * Render one feature-film scene on its own, start to finish: a real video shot,
 * narration, and a quiet music bed. Scenes are rendered independently so a bad
 * five minutes can be re-rendered without touching the rest of the picture.
 * Every scene comes out at the same size, frame rate and audio layout, so they
 * can later be joined with `ffmpeg -c copy`.
 *
 * The picture is always a real render: the local ComfyUI first, then Wan 2.2 on
 * fal.ai. When neither can render, the scene fails with
 * `VideoBackendUnavailable` (AI_UNAVAILABLE) instead of fabricating a clip that
 * only looks like a result. Narration is optional: a scene without a voice still
 * renders, carrying only the music bed.
 */
export async function renderFeatureScene(
  scene: MovieScene,
  opts: { index: number; voice?: TtsVoice; seconds?: number; onStage?: (stage: SceneStage) => void } = { index: 1 },
): Promise<SceneRenderResult> {
  const dir = workDir();
  const stage = opts.onStage ?? (() => {});
  try {
    const voice = opts.voice ?? 'Kore';
    const seconds = opts.seconds ?? MAX_SCENE_SECONDS;

    // 1. The picture: local ComfyUI first, Wan 2.2 on fal.ai as the fallback.
    // No backend -> no scene.
    stage('scripting');
    if (!(await videoBackendReady())) {
      throw new VideoBackendUnavailable(videoBackendDetail());
    }
    stage('rendering');
    const prompt = buildVeoStylePrompt(`${scene.heading}. ${scene.visual}`);
    const { data } = await renderVideo({ prompt, negative: buildVeoStyleNegative() });
    const clip = path.join(dir, 'comfy.mp4');
    fs.writeFileSync(clip, data);

    // 2. Normalise to the film's fixed format and extend to the scene length.
    const shot = await normaliseShot(clip, dir, seconds);

    // 3. Narration, from the first voice that answers; a caption otherwise.
    stage('audio');
    const backends = narrationBackends();
    let narrationFile: string | null = null;
    let voiceSource: NarrationSource = 'none';
    if (backends.fish || backends.cloud || backends.tagalog || backends.offline) {
      const line = await narrate(scene.narration, voice);
      if (line) {
        narrationFile = path.join(dir, 'voice.wav');
        fs.writeFileSync(narrationFile, line.buffer);
        voiceSource = line.source;
      }
    }

    // 4. Lay the narration and the music bed onto the shot in one pass.
    const bed = await musicBed(seconds, scene.mood, dir);
    const out = path.join(dir, 'scene.mp4');
    await mixScene(shot, narrationFile, bed, seconds, out);
    stage('completed');
    return { data: fs.readFileSync(out), seconds, voiced: Boolean(narrationFile), voiceSource };
  } finally {
    cleanup(dir);
  }
}

export interface MovieResult {
  asset: AssetMeta;
  file: string;
  seconds: number;
  scenes: number;
  narrated: boolean;
  /** Which voice actually spoke, or 'none' when the film carries captions. */
  voice_source: NarrationSource;
  note: string;
}

/**
 * Render the whole film. Narration is synthesised line by line; if TTS is off or
 * fails the film still renders, with the music bed carrying it, and the result
 * says so plainly instead of pretending the voice is there.
 */
export async function renderMovie(
  script: MovieScript,
  opts: MovieOptions,
  onProgress: ProgressFn = () => {},
): Promise<MovieResult> {
  const dir = workDir();
  try {
    const voice = opts.voice ?? 'Kore';
    resetNarration();
    const backends = narrationBackends();
    let voiced = 0;
    let used: NarrationSource = 'none';

    // 1. Narration, one line per scene. The line falls back from the cloud voice
    //    to the offline one; a line neither can voice becomes a caption instead,
    //    so a film always comes out.
    onProgress({ stage: 'Boses', percent: 5, detail: 'Sinisimulan ang narration' });
    const lines: (string | null)[] = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      if (!backends.cloud && !backends.offline) {
        lines.push(null);
        continue;
      }
      const line = await narrate(scene.narration, voice);
      if (line) {
        const file = path.join(dir, `voice${i}.wav`);
        fs.writeFileSync(file, line.buffer);
        lines.push(file);
        voiced++;
        used = line.source;
      } else {
        lines.push(null);
        onProgress({ stage: 'Boses', percent: 5, detail: `Walang boses para sa eksena ${i + 1} — caption na lang` });
      }
      onProgress({ stage: 'Boses', percent: 5 + Math.round((30 * (i + 1)) / script.scenes.length), detail: `Linya ${i + 1}/${script.scenes.length}` });
    }
    const narrated = voiced > 0;

    // 2. One shot per scene. Each shot runs at least long enough to hold its
    //    line, and the shots share the remaining time so the film lands on the
    //    length that was asked for even when the lines are short.
    const TITLE_SECONDS = 7;
    const CREDIT_SECONDS = 8;
    const target = Math.max(30, opts.minutes * 60);
    const perScene = Math.max(6, (target - TITLE_SECONDS - CREDIT_SECONDS) / script.scenes.length);
    const pieces: string[] = [];

    const titleMood = opts.mood ?? script.scenes[0]?.mood ?? 'warm';
    onProgress({ stage: 'Titulo', percent: 34 });
    const titleCard = await renderCard(
      [
        { text: script.title, size: 58, color: 'white' },
        { text: script.logline || 'Isang pelikulang gawa ng Movie Robo', size: 26, color: '0xf0e6c8' },
      ],
      TITLE_SECONDS,
      titleMood,
      dir,
      'title',
    );
    pieces.push(await muxNarration(titleCard, null, TITLE_SECONDS, dir, 'p_title'));

    for (let i = 0; i < script.scenes.length; i++) {
      const scene = script.scenes[i];
      const narrationFile = lines[i];
      let speechSeconds = 0;
      if (narrationFile) {
        const info = await probe(narrationFile);
        speechSeconds = info.duration;
      }
      const seconds = Math.min(MAX_SCENE_SECONDS, Math.max(perScene, speechSeconds + 3.2));
      onProgress({
        stage: 'Shots',
        percent: 36 + Math.round((48 * i) / script.scenes.length),
        detail: `Eksena ${i + 1}/${script.scenes.length} · ${seconds.toFixed(1)}s`,
      });
      const shot = await renderShot(scene, i, dir, seconds, { caption: !narrationFile });
      pieces.push(await muxNarration(shot, narrationFile, seconds, dir, `p_shot${i}`));
    }

    onProgress({ stage: 'Credits', percent: 86 });
    const credits = await renderCard(
      [
        { text: 'MOVIE CREATOR', size: 44, color: 'white' },
        { text: `Direksyon: Movie Robo · Boses: ${voice}`, size: 24, color: '0xf0e6c8' },
        { text: 'Gawa sa local render engine (ffmpeg)', size: 22, color: '0xc8c8c8' },
      ],
      CREDIT_SECONDS,
      titleMood,
      dir,
      'credits',
    );
    pieces.push(await muxNarration(credits, null, CREDIT_SECONDS, dir, 'p_credits'));

    // 3. Join the shots.
    onProgress({ stage: 'Pagsasama', percent: 89 });
    const joined = await concatVideos(pieces, WIDTH, HEIGHT);
    const joinedFile = path.join(dir, 'joined.mp4');
    fs.writeFileSync(joinedFile, joined.data);

    // 4. Lay the music bed under the whole film.
    onProgress({ stage: 'Musika', percent: 93 });
    const total = (await probe(joinedFile)).duration;
    const bed = await musicBed(Math.max(1, total), titleMood, dir);
    const finalFile = path.join(dir, 'movie.mp4');
    await ff([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', joinedFile, '-i', bed,
      '-filter_complex', '[1:a]volume=0.16[m];[0:a][m]amix=inputs=2:duration=first[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', finalFile,
    ]);

    const info = await probe(finalFile);
    const data = fs.readFileSync(finalFile);
    onProgress({ stage: 'Pagsagip', percent: 97 });

    const asset = saveAsset(data, {
      title: script.title,
      ext: 'mp4',
      mime: 'video/mp4',
      source: 'movie-creator',
      prompt: script.logline,
    });

    onProgress({ stage: 'Tapos', percent: 100 });
    const voiceLabel =
      used === 'fish' ? 'Fish Audio (Tagalog)'
        : used === 'tagalog' ? 'Tagalog na boses (MMS, offline)'
          : used === 'gemini' ? 'Gemini TTS'
            : used === 'piper' ? 'offline na boses (Piper)'
              : 'wala';
    return {
      asset,
      file: finalFile,
      seconds: info.duration,
      scenes: script.scenes.length,
      narrated,
      voice_source: used,
      note: narrated
        ? `Pelikula: ${script.scenes.length} eksena, ${info.duration.toFixed(0)}s. Boses: ${voiceLabel} (${voiced}/${script.scenes.length} linya).`
        : `Pelikula: ${script.scenes.length} eksena, ${info.duration.toFixed(0)}s. Walang boses — nakasulat ang kuwento sa video at may musika.`,
    };
  } finally {
    cleanup(dir);
  }
}
