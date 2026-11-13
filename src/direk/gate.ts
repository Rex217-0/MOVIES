/**
 * The haba/mood gate: ask for missing essentials before generating.
 * Ported from direk/gate.py, with the original bug fixed: genre words
 * (horror, comedy, ...) no longer satisfy the mood requirement.
 */

// Tonal descriptors only. Genre words (horror, comedy, romance, ...) are
// handled by `genres.findGenre`, so they must NOT count as a mood here — that
// overlap was a bug in the original Python service.
export const MOOD_WORDS = [
  'masaya', 'malungkot', 'nakakakaba', 'mabigat', 'magaan', 'madilim',
  'emotional', 'inspirasyon',
  'nostalgic', 'warm', 'light', 'dark',
  'happy', 'sad', 'scary', 'funny', 'tense', 'heavy', 'serious', 'hopeful',
];

// Tagalog joins the number to the unit with a hyphen and often adds -ng, as in
// "2-minutong pelikula". The hyphen and suffix must be accepted, or the gate
// keeps asking for a length the user already gave.
export const DURATION_RE = /\d+\s*-?\s*(segundo|segundong|sec|second|minuto|minutong|min|minute|oras|hour)/i;

export const GATE_QUESTIONS: Record<string, string> = {
  haba: 'Bago ako gumawa: gaano katagal ang gusto mo? Halimbawa: 30 segundo, 3 minuto, o 45 minuto.',
  mood: 'Anong mood ang gusto mo? Halimbawa: masaya, malungkot, nakakakaba, o mabigat.',
};

/** Return the list of essentials absent from `text` ("haba" / "mood"). */
export function missingFields(text: string): string[] {
  const lowered = (text || '').toLowerCase();
  const missing: string[] = [];
  if (!DURATION_RE.test(lowered)) missing.push('haba');
  if (!MOOD_WORDS.some(word => lowered.includes(word))) missing.push('mood');
  return missing;
}

/** Return the question to ask first, or null if generation may proceed. */
export function gateQuestion(text: string): string | null {
  const missing = missingFields(text);
  return missing.length ? GATE_QUESTIONS[missing[0]] : null;
}
