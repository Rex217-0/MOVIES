/**
 * Keyword -> genre mapping used for catalog lookups.
 * Ported from the original Direk Python service (direk/genres.py).
 */

export const GENRE_MAP: Record<string, string> = {
  action: 'action',
  aksyon: 'action',
  drama: 'drama',
  horror: 'horror',
  katatakutan: 'horror',
  'sci-fi': 'sci-fi',
  'sci fi': 'sci-fi',
  'science fiction': 'sci-fi',
  romance: 'romantic',
  romantic: 'romantic',
  romantiko: 'romantic',
  'love story': 'romantic',
  comedy: 'comedy',
  komedya: 'comedy',
  thriller: 'thriller',
  documentary: 'documentary',
  dokumentaryo: 'documentary',
  animation: 'animation',
  anime: 'anime',
};

/**
 * Genre ids above are the words people say. The catalog stores plural section
 * names ("Comedies", "Documentaries", "Romantic Movies"), so each genre maps to
 * one or more search terms.
 */
const CATALOG_TERMS: Record<string, string[]> = {
  comedy: ['comedies', 'comedy'],
  documentary: ['documentaries', 'documentary'],
  romantic: ['romantic', 'romance'],
  action: ['action'],
  drama: ['drama'],
  horror: ['horror'],
  'sci-fi': ['sci-fi', 'science fiction'],
  thriller: ['thriller'],
  animation: ['animation', 'animated'],
  anime: ['anime'],
};

/** Return the first catalog genre mentioned in `text`, or null. */
export function findGenre(text: string): string | null {
  const lowered = (text || '').toLowerCase();
  const words = Object.keys(GENRE_MAP).sort((a, b) => b.length - a.length);
  for (const word of words) {
    if (lowered.includes(word)) return GENRE_MAP[word];
  }
  return null;
}

/** Return the search terms for a genre id, or null. */
export function catalogTerms(genre: string | null): string[] | null {
  if (!genre) return null;
  return CATALOG_TERMS[genre] ?? [genre];
}
