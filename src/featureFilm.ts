/**
 * Feature Film Factory constants, shared by the server engine and the browser.
 *
 * Like movieMeta.ts this module must stay free of Node imports so Vite can
 * bundle it for the client, which renders the 18 progress bars.
 *
 * The film is fixed at 18 scenes of 5 minutes each, so one continuous 90-minute
 * feature comes out. The split exists for quality control: a bad five minutes is
 * re-rendered on its own instead of the whole picture.
 */

import type { Mood } from './movieMeta';

/** Scenes in one feature film. */
export const FEATURE_SCENES = 18;

/** Seconds in one scene: five minutes, exactly. */
export const FEATURE_SCENE_SECONDS = 300;

/** Seconds in the finished film: 90 minutes. */
export const FEATURE_TOTAL_SECONDS = FEATURE_SCENES * FEATURE_SCENE_SECONDS;

/** The pace the factory aims for: one five-minute scene every two minutes. */
export const SCENE_TARGET_SECONDS = 120;

/** Three acts, six scenes each. */
export const FEATURE_ACTS = 3;

export const RATINGS = ['G', 'PG', 'SPG', 'R'] as const;
export type Rating = (typeof RATINGS)[number];

export const RATING_LABELS: Record<Rating, string> = {
  G: 'G — Para sa lahat',
  PG: 'PG — May gabay ng magulang',
  SPG: 'SPG — Striktong gabay ng magulang',
  R: 'R — Bawal sa wala pang 18',
};

export const FORMATS = ['Animated', 'Realistic'] as const;
export type FilmFormat = (typeof FORMATS)[number];

/** One movie concept: what the whole 90 minutes is about. */
export interface MovieConcept {
  title: string;
  genre: string;
  rating: Rating;
  format: FilmFormat;
  brief: string;
}

/** Where a scene sits in the batch: pending, rendering, or reviewed. */
export type SceneStatus =
  | 'pending'
  | 'rendering'
  | 'rendered'
  | 'failed'
  | 'approved'
  | 'rejected';

export interface FeatureScene {
  /** 1-based position in the film, 1 to 18. */
  index: number;
  /** Which of the three acts it belongs to, 1 to 3. */
  act: number;
  heading: string;
  /** The story beat this scene carries. */
  beat: string;
  /** Tagalog voice-over for the scene. */
  narration: string;
  /** Short English description of the shot. */
  visual: string;
  mood: Mood;
  /** Always FEATURE_SCENE_SECONDS: 300. */
  seconds: number;
}

/** Scene index (1-based) -> its act number (1-based). */
export function actOf(index: number): number {
  const perAct = FEATURE_SCENES / FEATURE_ACTS;
  return Math.min(FEATURE_ACTS, Math.floor((index - 1) / perAct) + 1);
}

/** Seconds -> "H:MM:SS", for the film clock. */
export function filmClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
