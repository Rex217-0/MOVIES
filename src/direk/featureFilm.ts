/**
 * Feature Film Factory: one concept in, an 18-scene 90-minute breakdown out.
 *
 * The film is split into 18 five-minute scenes so each one can be reviewed and
 * re-rendered on its own. This module is pure: it turns a concept into a scene
 * list with no model and no filesystem, so it is easy to test and cheap to run.
 */

import { MOODS, type Mood } from '../movieMeta.ts';
import {
  FEATURE_SCENES, FEATURE_SCENE_SECONDS, actOf,
  RATINGS, FORMATS, type MovieConcept, type Rating, type FilmFormat, type FeatureScene,
} from '../featureFilm.ts';

export interface ConceptOptions {
  title?: string;
  genre?: string;
  rating?: Rating;
  format?: FilmFormat;
  /** One sentence describing the film. */
  brief: string;
  /** Force a mood for every scene; otherwise each scene picks its own. */
  mood?: Mood;
}

const GENRE_WORDS: [RegExp, string][] = [
  [/\bhorror|katatakutan|nakakakaba|multo|aswang\b/i, 'horror'],
  [/\bromance|romantiko|pag-ibig|pagibig|love\b/i, 'romantic'],
  [/\bcomedy|komedya|nakakatawa|masaya\b/i, 'comedy'],
  [/\baksiyon|action|labanan|barilan|habulan\b/i, 'action'],
  [/\bsci-?fi|science fiction|mars|space|dayuhan|robot\b/i, 'sci-fi'],
  [/\bthriller|suspense|sikreto|lihim|lum\b/i, 'thriller'],
  [/\bdokumentaryo|documentary|tunay na buhay\b/i, 'documentary'],
  [/\banimasyon|animation|anime\b/i, 'animation'],
];

/** Guess the genre from the words in the brief. */
export function guessGenre(brief: string): string {
  for (const [pattern, genre] of GENRE_WORDS) {
    if (pattern.test(brief)) return genre;
  }
  return 'drama';
}

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map(w => (w.length > 3 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** A title from the brief: the first few content words, title-cased. */
export function deriveTitle(brief: string): string {
  const words = (brief || '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
  const skip = new Set(['ang', 'ng', 'sa', 'na', 'at', 'isang', 'may', 'si', 'ni', 'mga', 'the', 'a', 'of']);
  const kept = words.filter(w => !skip.has(w.toLowerCase())).slice(0, 4);
  const title = titleCase((kept.length ? kept : words.slice(0, 4)).join(' '));
  return title || 'Isang Pelikula';
}

/** Pick a rating: explicit when given, otherwise from the content. */
export function guessRating(brief: string, explicit?: Rating): Rating {
  if (explicit && RATINGS.includes(explicit)) return explicit;
  if (/\b(bata|pamilya|pambata|kids|children)\b/i.test(brief)) return 'G';
  if (/\b(krimen|karahasan|digmaan|baril|dahas|madugo|patay|blood|violence)\b/i.test(brief)) return 'R';
  if (/\b(aswang|multo|horror|katatakutan|sikreto|lihim|gabi)\b/i.test(brief)) return 'SPG';
  return 'PG';
}

/** Pick the format: explicit when given, otherwise animation words win. */
export function guessFormat(brief: string, explicit?: FilmFormat): FilmFormat {
  if (explicit && FORMATS.includes(explicit)) return explicit;
  if (/\b(animasyon|animation|anime|kartun|cartoon|drawing)\b/i.test(brief)) return 'Animated';
  return 'Realistic';
}

/**
 * Build the movie concept. Every field is derived from the brief when it is not
 * given, so one sentence is enough to start a film.
 */
export function buildConcept(opts: ConceptOptions): MovieConcept {
  const brief = (opts.brief || '').trim() || 'Isang pelikula tungkol sa isang tao at isang pagpili.';
  return {
    title: (opts.title || '').trim() || deriveTitle(brief),
    genre: (opts.genre || '').trim() || guessGenre(brief),
    rating: guessRating(brief, opts.rating),
    format: guessFormat(brief, opts.format),
    brief,
  };
}

/**
 * The story beats, one per scene, in order. Three acts of six: the setup, the
 * turn, and the resolution, so the film has a real shape across 90 minutes.
 */
const BEATS: string[] = [
  'Pagbubukas: ipinapakilala ang mundo at ang pangunahing tauhan.',
  'Ang pang-araw-araw na buhay; may maliit na palatandaan na hindi tama.',
  'Dumarating ang isang bisita o balita na nagbabago ng takbo.',
  'Nauudyok ang tauhan na gumawa ng unang hakbang.',
  'Nakikita ang panganib; lumalabo ang pagpipilian.',
  'Tapos ang unang yugto: may pasyang hindi na maibabalik.',
  'Nagsisimula ang tunay na problema; tumitindi ang panggigipit.',
  'Isang kaalyado ang lumitaw, pero may sariling hangarin.',
  'Nabubunyag ang isang lihim na nagbabago ng lahat.',
  'Ang unang pagtatangka ay nabigo nang malaki.',
  'Nawawalan ng pag-asa ang tauhan; lumalapit ang kalaban.',
  'Tapos ang ikalawang yugto: nasa pinakamababa ang tauhan.',
  'Ang pagtuklas na magiging susi sa pagwawakas.',
  'Ang plano: isang huling pagtatangka, walang atrasan.',
  'Ang madilim na gabi ng paghaharap.',
  'Ang tugatog: isang pagpili ang magpapasya sa lahat.',
  'Ang paglutas: naiwan ang bagyo, may nawala at may natagpuan.',
  'Pagwawakas: paalam, at ang bagong simula.',
];

const MOOD_CYCLE: Mood[] = ['warm', 'hopeful', 'tense', 'grim', 'cold', 'dreamy'];

/** The beat for a 1-based scene index. */
export function beatFor(index: number): string {
  const i = Math.max(1, Math.min(FEATURE_SCENES, index));
  return BEATS[i - 1] ?? BEATS[BEATS.length - 1];
}

/**
 * Split a concept into 18 five-minute scenes. The beat drives the narration and
 * the visual, and the mood cycles so the film has variety across its length.
 */
export function buildScenes(concept: MovieConcept, mood?: Mood): FeatureScene[] {
  const scenes: FeatureScene[] = [];
  for (let i = 1; i <= FEATURE_SCENES; i++) {
    const beat = beatFor(i);
    const sceneMood = mood ?? MOOD_CYCLE[(i - 1) % MOOD_CYCLE.length];
    scenes.push({
      index: i,
      act: actOf(i),
      heading: `SCENE ${i} — ${concept.title}, Acto ${actOf(i)}`,
      beat,
      narration: `${beat} Sa eksenang ito ng "${concept.title}", ipinagpapatuloy ang kuwento: ${concept.brief}`,
      visual: `${concept.format.toLowerCase()} ${concept.genre} shot ${i} of 18, ${concept.title}`,
      mood: sceneMood,
      seconds: FEATURE_SCENE_SECONDS,
    });
  }
  return scenes;
}

/** A prompt that asks a text model for a richer 18-scene breakdown. */
export function breakdownPrompt(concept: MovieConcept): string {
  return [
    `Ikaw si Movie Robo, direktor ng isang 90-minutong tampok na pelikula.`,
    `Pamagat: ${concept.title}`,
    `Genre: ${concept.genre} · Rating: ${concept.rating} · Format: ${concept.format}`,
    `Brief: ${concept.brief}`,
    ``,
    `Hatiin ang pelikula sa ${FEATURE_SCENES} eksena, bawat isa ay ${FEATURE_SCENE_SECONDS / 60} minuto.`,
    `Sumagot lamang ng JSON na ganito ang hugis:`,
    `{"scenes":[{"heading":"...","narration":"...","visual":"...","mood":"warm"}]}`,
    ``,
    `Mga tuntunin:`,
    `- Eksaktong ${FEATURE_SCENES} eksena, may simula, gitna, at wakas.`,
    `- Ang "narration" ay Tagalog na voice-over, 30 hanggang 45 salita.`,
    `- Ang "visual" ay maikling paglalarawan ng shot sa Ingles, 8 hanggang 16 salita.`,
    `- Ang "mood" ay isa sa: ${MOODS.join(', ')}.`,
    `- Walang markdown, walang paliwanag, JSON lang.`,
  ].join('\n');
}

/**
 * Pull a scene list out of a model reply that may carry prose or fences. Returns
 * the parsed payload so `mergeScenes` can fold it onto the deterministic set;
 * null when nothing usable arrived.
 */
export function parseBreakdown(raw: string): unknown | null {
  if (!raw) return null;
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const end = raw.lastIndexOf('}');
  const body = end > start ? raw.slice(start, end + 1) : raw.slice(start);
  try {
    const payload = JSON.parse(body);
    if (payload && Array.isArray(payload.scenes) && payload.scenes.length >= 3) return payload;
  } catch {
    /* fall through to the salvaged form */
  }
  const re = /\{[^{}]*"narration"\s*:\s*"(?:[^"\\]|\\.)*"[^{}]*\}/g;
  const salvage = (text: string): any[] => {
    const scenes: any[] = [];
    for (const match of text.matchAll(re)) {
      try {
        scenes.push(JSON.parse(match[0]));
      } catch {
        /* skip a malformed scene */
      }
    }
    return scenes;
  };
  // A reply cut off mid-array still has whole scene objects; scan the trimmed
  // body first, then the whole reply in case the last brace was partial.
  const scenes = salvage(body).length >= 3 ? salvage(body) : salvage(raw.slice(start));
  return scenes.length >= 3 ? { scenes } : null;
}

/**
 * Accept a model's scene list when it returned a usable one, otherwise keep the
 * deterministic breakdown. The length is always forced to 18 so the factory can
 * plan 18 renders.
 */
export function mergeScenes(model: unknown, fallback: FeatureScene[], concept: MovieConcept): FeatureScene[] {
  const raw = (model as any)?.scenes;
  if (!Array.isArray(raw) || raw.length < 3) return fallback;
  const scenes: FeatureScene[] = [];
  for (let i = 1; i <= FEATURE_SCENES; i++) {
    const source = raw[i - 1] ?? {};
    const base = fallback[i - 1];
    const mood = (MOODS as string[]).includes(String(source.mood)) ? (source.mood as Mood) : base.mood;
    scenes.push({
      index: i,
      act: actOf(i),
      heading: String(source.heading || base.heading).slice(0, 120),
      beat: base.beat,
      narration: String(source.narration || base.narration).slice(0, 400),
      visual: String(source.visual || base.visual).slice(0, 200),
      mood,
      seconds: FEATURE_SCENE_SECONDS,
    });
  }
  return scenes;
}
