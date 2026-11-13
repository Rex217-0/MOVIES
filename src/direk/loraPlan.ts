/**
 * Turn a Direk brief into a concrete LoRA plan.
 *
 * The plan reuses everything the director already knows: the genre catalog
 * (for visual references), the box-office presets (for a sensible shot count
 * and runtime) and the character bible (for a consistent look). Nothing here
 * needs a model — it is deterministic, so it works with no API key.
 */

import { ReferenceCatalog, type CatalogTitle } from './reference.ts';
import { MarketIntel } from './market.ts';
import { toSlug, type LoraBrief, type LoraSample, type LoraCharacter } from './lora.ts';

export interface LoraPlanInput {
  title: string;
  genre: string;
  mood: string;
  durationMinutes?: number;
  trigger?: string;
  character?: Partial<LoraCharacter>;
  baseModel?: string;
}

export interface LoraPlan {
  brief: LoraBrief;
  /** The catalog titles whose look informed the plan. */
  references: CatalogTitle[];
  /** Human-readable notes on how the plan was sized. */
  notes: string[];
}

const DEFAULT_SHOTS = 12;

/** Pick a shot count that fits the runtime, in a trainable range. */
export function shotsForDuration(minutes?: number): number {
  if (!minutes || minutes <= 0) return DEFAULT_SHOTS;
  const shots = Math.round(minutes * 2);
  return Math.max(6, Math.min(shots, 40));
}

function defaultCharacter(title: string, genre: string): LoraCharacter {
  return {
    name: 'Bida',
    look: `sariwang mukha, konsistent sa buong ${genre}`,
    wardrobe: 'simpleng damit na bagay sa eksena',
  };
}

/** Build a deterministic LoRA plan from a brief. */
export function planLora(
  input: LoraPlanInput,
  catalog?: ReferenceCatalog,
  market?: MarketIntel,
): LoraPlan {
  const notes: string[] = [];
  const references = catalog?.search(input.genre, 'Movie', 5) ?? [];
  if (references.length) {
    notes.push(`Ginamit ang ${references.length} reference titles para sa itsura at tono.`);
  }

  const shots = shotsForDuration(input.durationMinutes);
  notes.push(`${shots} training samples (${input.durationMinutes ?? DEFAULT_SHOTS / 2} minuto).`);

  const character: LoraCharacter = {
    ...defaultCharacter(input.title, input.genre),
    ...input.character,
  };

  const trigger = input.trigger || `direk_${toSlug(input.title)}`;
  const marketNote = market?.available ? market.brief() : undefined;

  const stages = ['KARAKTER', 'SHOT_LIST', 'VISUAL'] as const;
  const samples: LoraSample[] = [];
  for (let i = 0; i < shots; i++) {
    const stage = stages[i % stages.length];
    const reference = references[i % Math.max(references.length, 1)];
    const look = reference ? `sa estilo ng "${reference.title}"` : `${input.mood} na ${input.genre}`;
    samples.push({
      slug: `shot_${String(i + 1).padStart(3, '0')}`,
      stage,
      prompt: `${character.name}, ${look}, ${input.mood}, cinematic lighting, 35mm film`,
    });
  }

  const brief: LoraBrief = {
    title: input.title,
    genre: input.genre,
    mood: input.mood,
    durationMinutes: input.durationMinutes,
    trigger,
    character,
    samples,
    baseModel: input.baseModel,
    marketNote,
  };

  return { brief, references, notes };
}
