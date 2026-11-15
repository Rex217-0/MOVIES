/**
 * The Direk service: gate + references + model + action parsing.
 * Ported from direk/service.py.
 *
 * The model call is injected as `generate`, so the service stays testable and
 * the HTTP layer owns the Gemini client and its error handling.
 */

import { ReferenceCatalog, type CatalogTitle } from './reference.ts';
import { findGenre } from './genres.ts';
import { gateQuestion, missingFields } from './gate.ts';
import { buildSystemPrompt } from './persona.ts';
import { extractAction, type SkillAction } from './skills.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DirekReply {
  reply: string;
  genre: string | null;
  gate: string | null;
  references: CatalogTitle[];
  action: SkillAction | null;
  action_error: string | null;
  market_brief: string | null;
}

export type GenerateFn = (systemPrompt: string, messages: ChatMessage[]) => Promise<string>;

export class DirekService {
  private catalog: ReferenceCatalog;
  private generate: GenerateFn;
  private marketBrief: () => string;

  constructor(catalog: ReferenceCatalog, generate: GenerateFn, marketBrief: () => string = () => '') {
    this.catalog = catalog;
    this.generate = generate;
    this.marketBrief = marketBrief;
  }

  health() {
    return {
      persona: 'Movie Robo',
      brand: 'Moviecity',
      operator: 'LJR Group',
      reference_available: this.catalog.available,
      reference_rows: this.catalog.size,
    };
  }

  async chat(messages: ChatMessage[]): Promise<DirekReply> {
    const incoming = messages.filter(m => m.role !== 'system');
    const lastUser = [...incoming].reverse().find(m => m.role === 'user')?.content ?? '';
    const genre = findGenre(lastUser);

    // haba/mood gate, only when a catalog genre is in play
    if (genre) {
      const question = gateQuestion(lastUser);
      if (question) {
        return {
          reply: question,
          genre,
          gate: missingFields(lastUser)[0] ?? null,
          references: [],
          action: null,
          action_error: null,
          market_brief: null,
        };
      }
    }

    const references = genre ? this.catalog.search(genre, 'Movie') : [];
    const market = this.marketBrief();
    let systemPrompt = buildSystemPrompt(references, genre);
    if (market) systemPrompt += `\n\nDATA NG MERKADO (totoong box-office stats): ${market}`;
    const raw = await this.generate(systemPrompt, incoming);
    const [reply, action, action_error] = extractAction(raw);

    return { reply, genre, gate: null, references, action, action_error, market_brief: market || null };
  }
}
