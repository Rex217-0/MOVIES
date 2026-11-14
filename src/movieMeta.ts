/**
 * Movie constants shared by the server engine and the browser UI.
 *
 * This module must stay free of Node imports so Vite can bundle it for the
 * client, where it fills the mood and voice pickers.
 */

export type Mood = 'warm' | 'cold' | 'tense' | 'dreamy' | 'grim' | 'hopeful';

export const MOODS: Mood[] = ['warm', 'cold', 'tense', 'dreamy', 'grim', 'hopeful'];

export const MOOD_LABELS: Record<Mood, string> = {
  warm: 'Mainit',
  cold: 'Malamig',
  tense: 'Tense',
  dreamy: 'Panaginip',
  grim: 'Madilim',
  hopeful: 'May pag-asa',
};

export const TTS_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda'] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 5;

export interface MovieOptions {
  minutes: number;
  mood?: Mood;
  voice?: TtsVoice;
  title?: string;
}

/** Shots a film of this length wants: one per ~28 seconds. */
export function sceneCount(minutes: number): number {
  const total = Math.max(1, minutes) * 60;
  return Math.min(24, Math.max(3, Math.round(total / 28)));
}
