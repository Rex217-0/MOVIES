/**
 * Grounding for the Movie Generator.
 *
 * A raw LLM prompt invents everything. This module grounds the screenplay in
 * the bundled data instead: the ReferenceCatalog (real titles, genres, casts)
 * and the MarketIntel box-office stats (genre market share, production
 * methods, ratings). The result is a compact, factual block that is folded into
 * the script prompt, so the story structure, pacing and genre tropes come from
 * real films and real market numbers rather than from the model's imagination.
 *
 * Nothing here needs a model: it is deterministic and works with no API key.
 * When a dataset is missing the relevant part is simply empty.
 */

import type { ReferenceCatalog, CatalogTitle } from './reference.ts';
import type { MarketIntel } from './market.ts';
import { findGenre } from './genres.ts';

export interface MovieGrounding {
  /** The catalog genre the brief matched, or null when none did. */
  genre: string | null;
  /** Real reference titles whose look and tone match the genre. */
  references: CatalogTitle[];
  /** One-line box-office summary, straight from the CSVs. */
  market_brief: string;
  /** How the film should be paced, derived from the length and the market. */
  pacing: string;
  /** Genre tropes drawn from the reference titles' own genres. */
  tropes: string[];
}

/** The most common genres across the reference titles, most frequent first. */
export function topTropes(references: CatalogTitle[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const ref of references) {
    for (const g of ref.listed_in.split(',').map(s => s.trim()).filter(Boolean)) {
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([g]) => g);
}

/**
 * A pacing line for a film of `minutes`. Short films run three acts tightly;
 * longer ones get more beats per act, which is what the scene count follows.
 */
export function pacingFor(minutes: number, sceneCount: number): string {
  const perScene = sceneCount > 0 ? (minutes * 60) / sceneCount : 0;
  const act = Math.max(1, Math.round(sceneCount / 3));
  return (
    `${minutes} minuto, ${sceneCount} eksena (~${perScene.toFixed(0)}s bawat isa), ` +
    `tatlong acto ng ~${act} eksena: pagbubukas, paglalim, pagwawakas.`
  );
}

/**
 * Query the datasets for everything the screenplay should respect. Both
 * dependencies are optional so the caller can run with no data at all.
 */
export function groundMovie(
  brief: string,
  opts: { minutes: number; sceneCount: number },
  catalog?: ReferenceCatalog,
  market?: MarketIntel,
): MovieGrounding {
  const genre = findGenre(brief);
  const references = genre && catalog ? catalog.search(genre, 'Movie', 6) : [];
  const marketBrief = market?.available ? market.brief() : '';
  return {
    genre,
    references,
    market_brief: marketBrief,
    pacing: pacingFor(opts.minutes, opts.sceneCount),
    tropes: topTropes(references),
  };
}

/**
 * Render the grounding as a prompt block. Returns '' when there is nothing to
 * ground with, so the caller can append it unconditionally.
 */
export function groundingBlock(grounding: MovieGrounding): string {
  const lines: string[] = [];
  if (grounding.genre) lines.push(`Genre (mula sa brief): ${grounding.genre}`);
  if (grounding.references.length) {
    lines.push('Totoong reference na pelikula (gawing gabay sa tono at itsura):');
    for (const ref of grounding.references) {
      const year = ref.release_year ? ` (${ref.release_year})` : '';
      const genres = ref.listed_in ? ` — ${ref.listed_in}` : '';
      lines.push(`- ${ref.title}${year}${genres}`);
    }
  }
  if (grounding.tropes.length) {
    lines.push(`Karaniwang genre tropes sa mga reference: ${grounding.tropes.join(', ')}.`);
  }
  if (grounding.market_brief) {
    lines.push(`Box-office na datos (totoong market share): ${grounding.market_brief}`);
  }
  lines.push(`Pacing: ${grounding.pacing}`);
  if (!lines.length) return '';
  return ['DATOS NA GABAY (totoong datasets, huwag labagin):', ...lines].join('\n');
}
