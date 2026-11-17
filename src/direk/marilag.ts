/**
 * Marilag Originals: the 10-movie batch.
 *
 * Ten distinct cinematic concepts, each a 60-minute feature told in 12 scenes of
 * five minutes. The concepts are deterministic: the same batch is the same ten
 * films every run, so a re-run is reproducible and reviewable.
 *
 * A concept here is only a brief. Whether a movie actually renders is decided by
 * the factory: video is ComfyUI-only, so a film without a working ComfyUI backend
 * fails with an honest reason and is never replaced by a slideshow.
 */

import type { Mood } from '../movieMeta.ts';
import type { ConceptOptions } from './featureFilm.ts';

/** Scenes in one Marilag feature. Twelve scenes of five minutes is 60 minutes. */
export const MARILAG_SCENES = 12;

/** Seconds in one Marilag feature: exactly 60 minutes. */
export const MARILAG_SECONDS = 60 * 60;

/** How many films one Marilag batch queues. */
export const MARILAG_MOVIES = 10;

export interface MarilagMovie {
  /** 1-based position in the batch. */
  index: number;
  title: string;
  genre: string;
  mood: Mood;
  brief: string;
}

/**
 * Ten cinematic Tagalog titles, mixed genres, each with a one-line brief and a
 * mood. The list is fixed so the batch is the same ten films on every run.
 */
export const MARILAG_MOVIES_LIST: ReadonlyArray<Omit<MarilagMovie, 'index'>> = [
  {
    title: 'Alon sa Maynila',
    genre: 'Drama',
    mood: 'warm',
    brief: 'Isang mangingisdang nawalan ng bangka ang namasukan sa Maynila upang hanapin ang anak na tumakas patungong siyudad.',
  },
  {
    title: 'Ang Huling Biyahe ng Bapor Perlas',
    genre: 'Adventure',
    mood: 'hopeful',
    brief: 'Sa huling paglalayag ng lumang bapor, isang inhinyero at isang batang polis ang nagtulungan laban sa bagyo at sa lihim ng kargamento.',
  },
  {
    title: 'Bakas ng Ulan',
    genre: 'Romance',
    mood: 'dreamy',
    brief: 'Dalawang estranghero na paulit-ulit na nagkikita tuwing umuulan ang natutong magmahal sa pagitan ng paalam at pagbabalik.',
  },
  {
    title: 'Ang Tao sa Salamin ng Bulkan',
    genre: 'Thriller',
    mood: 'tense',
    brief: 'Isang geologong nag-iisa sa paanan ng bulkan ang nakatuklas ng kopya ng sarili sa mga lumang litrato ng bayang nawala.',
  },
  {
    title: 'Himagsik sa Nayon ng Tubig',
    genre: 'Action',
    mood: 'grim',
    brief: 'Sa nayong binaha ng dam, isang dating sundalo ang namuno sa mga magsasaka laban sa mga nagpapabaya sa kanila.',
  },
  {
    title: 'Awit ng Nawawalang Buwan',
    genre: 'Fantasy',
    mood: 'dreamy',
    brief: 'Isang mang-aawit na may tinig na nakakapagpagaling ang hinanap ng diwata upang ibalik ang buwang ninakaw ng dilim.',
  },
  {
    title: 'Pintuan ng Gabi',
    genre: 'Horror',
    mood: 'grim',
    brief: 'Isang pamilyang lumipat sa lumang bahay na may pintuang tuwing hatinggabi ay bumubukas sa hindi dapat tingnan.',
  },
  {
    title: 'Kape sa Dulo ng Daigdig',
    genre: 'Sci-Fi',
    mood: 'cold',
    brief: 'Sa huling kapitbahayan bago ang walang hanggang karagatan, isang baristang robot ang naghihintay ng huling kostumer.',
  },
  {
    title: 'Ang Bida ay si Lola',
    genre: 'Comedy',
    mood: 'warm',
    brief: 'Isang lola na mahilig sa tiktok ang naging viral at napilitang harapin ang mga apo at ang camera nang sabay.',
  },
  {
    title: 'Riles ng Pangarap',
    genre: 'Family',
    mood: 'hopeful',
    brief: 'Mag-ama na taga-repair ng riles ang naglalakbay pahilaga upang maabot ang huling pagsusulit ng anak.',
  },
];

/** The ten Marilag concepts with their batch position. */
export function marilagMovies(): MarilagMovie[] {
  return MARILAG_MOVIES_LIST.map((m, i) => ({ index: i + 1, ...m }));
}

/** One Marilag concept as factory options. */
export function marilagConceptOptions(movie: MarilagMovie): ConceptOptions {
  return { brief: movie.brief, title: movie.title, genre: movie.genre, mood: movie.mood };
}
