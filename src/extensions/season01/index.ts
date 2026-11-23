/**
 * Season 1: the multi-source free LoRA image harvester, packaged as an
 * extension. Everything it needs is here; the core app only sees the contract.
 */

import path from 'node:path';
import type { ExtensionSkill, MovieCreatorExtension, RouteHost } from '../contract.ts';
import { harvestImagesForLora, HARVEST_SOURCES } from './loraHarvester.ts';
import { listDatasets } from './datasets.ts';
import {
  DEFAULT_GENRES, DEFAULT_PER_GENRE, loadSchedule, normalizeSchedule, runSeasonalHarvest, saveSchedule,
  slugifyBatch, startScheduleTicker, type ScheduleConfig,
} from './seasonalHarvester.ts';

/** Where runs live. Same default as the trainer, so a harvest is immediately trainable. */
export function runsRoot(): string {
  return process.env.KOHYA_RUNS_ROOT || path.join(process.cwd(), 'lora_runs');
}

/** The preset the LoRA Studio button uses. */
export const SCIFI_NEON_PRESET = {
  query: 'cyberpunk neon portrait futuristic hologram sci-fi',
  triggerToken: 'direk_scifi_neon',
  count: 15,
};

function asCount(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

async function runHarvest(args: Record<string, unknown>) {
  const result = await harvestImagesForLora({
    query: String(args.query ?? SCIFI_NEON_PRESET.query),
    triggerToken: String(args.triggerToken ?? args.trigger ?? SCIFI_NEON_PRESET.triggerToken),
    count: asCount(args.count),
    targetDir: args.targetDir ? String(args.targetDir) : undefined,
  });
  return {
    ok: result.saved > 0,
    saved: result.saved,
    requested: result.requested,
    trigger: result.triggerToken,
    targetDir: result.targetDir,
    sources: result.sourcesAnswered,
    usedQueries: result.usedQueries,
    samples: result.samples.map(s => ({ file: s.file, source: s.source, bytes: s.bytes })),
    failures: result.failures,
    note: result.note,
  };
}

/** Skill ids this season owns. Static, so the persona and tests can see them. */
export const SEASON_ONE_SKILLS = ['lora_harvest', 'lora_datasets', 'lora_harvest_batch'] as const;

const harvestSkill: ExtensionSkill = {
  id: 'lora_harvest',
  does: 'Humakot ng libreng larawan mula sa Wallhaven, Openverse at Wikimedia papuntang LoRA dataset.',
  args: '{query, triggerToken, count?}',
  run: runHarvest,
};

const datasetsSkill: ExtensionSkill = {
  id: 'lora_datasets',
  does: 'Ipakita ang mga LoRA dataset na nasa lora_runs at ang bilang ng sample.',
  args: '{}',
  run: async () => ({ datasets: listDatasets(runsRoot()) }),
};

const batchSkill: ExtensionSkill = {
  id: 'lora_harvest_batch',
  does: 'Seasonal 8-genre sweep: humakot ng 10 aprubadong PNG bawat genre sa Bodegero QC.',
  args: '{theme?, genres?, perGenreCount?, batchSlug?}',
  run: async args => {
    const result = await runSeasonalHarvest({
      batchSlug: slugifyBatch(String(args?.batchSlug ?? '')),
      theme: typeof args?.theme === 'string' ? args.theme : '',
      genres: Array.isArray(args?.genres) ? (args.genres as unknown[]).map(String) : undefined,
      perGenreCount: args?.perGenreCount !== undefined ? Number(args.perGenreCount) : undefined,
      root: runsRootParent(),
    });
    return {
      ok: result.ok,
      batchSlug: result.batchSlug,
      approved: result.approved,
      requested: result.requested,
      rejected: result.rejected,
      perGenre: result.perGenre.map(g => ({ genre: g.genre, approved: g.approved, target: g.target })),
      note: result.note,
    };
  },
};

export function createSeasonOneHarvester(): MovieCreatorExtension {
  return {
    id: 'season-01-harvester',
    name: 'Season 1 — Multi-Source Free LoRA Image Harvester',
    season: 1,
    version: '1.0.0',
    enabled: process.env.SEASON01_HARVESTER !== '0',
    skills: [harvestSkill, datasetsSkill, batchSkill],

    registerRoutes(app: RouteHost) {
      app.post('/api/extensions/season-01-harvester/harvest', async (req: any, res: any) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        try {
          const result = await runHarvest(body);
          // A harvest that saved nothing is a real failure, so it is not a 200.
          res.status(result.ok ? 200 : 502).json({
            ...result,
            sources_tried: HARVEST_SOURCES,
          });
        } catch (error: any) {
          res.status(400).json({ ok: false, error: error?.message || String(error) });
        }
      });

      app.get('/api/extensions/season-01-harvester/preset', (_req: any, res: any) => {
        res.json({ ...SCIFI_NEON_PRESET, sources: HARVEST_SOURCES });
      });

      // ---- Seasonal 8-genre sweep -------------------------------------------
      app.post('/api/extensions/season-01-harvester/harvest-batch', async (req: any, res: any) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        try {
          const result = await runSeasonalHarvest({
            batchSlug: slugifyBatch(String(body.batchSlug ?? body.batch_slug ?? '')),
            theme: typeof body.theme === 'string' ? body.theme : '',
            genres: Array.isArray(body.genres) ? body.genres.map(String) : undefined,
            perGenreCount: body.perGenreCount !== undefined ? Number(body.perGenreCount) : undefined,
            triggerToken: typeof body.triggerToken === 'string' ? body.triggerToken : undefined,
            root: runsRootParent(),
          });
          res.status(result.ok ? 200 : 502).json({ ...result, sources_tried: HARVEST_SOURCES });
        } catch (error: any) {
          res.status(400).json({ ok: false, error: error?.message || String(error) });
        }
      });

      // ---- Editable schedule -------------------------------------------------
      app.get('/api/extensions/season-01-harvester/schedule', (_req: any, res: any) => {
        res.json({
          ...loadSchedule(runsRootParent()),
          defaults: { genres: [...DEFAULT_GENRES], perGenreCount: DEFAULT_PER_GENRE },
        });
      });

      app.post('/api/extensions/season-01-harvester/schedule', (req: any, res: any) => {
        try {
          const saved = saveSchedule(normalizeSchedule(req.body ?? {}), runsRootParent());
          res.json({ ok: true, ...saved });
        } catch (error: any) {
          res.status(400).json({ ok: false, error: error?.message || String(error) });
        }
      });
    },
  };
}

/**
 * The folder that holds lora_runs, lora_staging and lora_rejected. Derived from
 * the runs root so an operator who moved the runs also moved the staging area.
 */
export function runsRootParent(): string {
  return path.dirname(runsRoot());
}

/**
 * Start the schedule ticker. Called once at boot, next to the registry mount, so
 * a saved schedule keeps working across restarts.
 */
export function startSeasonalScheduler(log: (msg: string) => void = msg => console.log(msg)): () => void {
  return startScheduleTicker(async (config: ScheduleConfig) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await runSeasonalHarvest({
      batchSlug: `${config.theme ? slugifyBatch(config.theme) : 'seasonal'}-${stamp}`,
      theme: config.theme,
      genres: config.genres,
      perGenreCount: config.perGenreCount,
      root: runsRootParent(),
    });
    log(`[SCHEDULE] ${result.note}`);
  }, { cwd: runsRootParent(), log });
}
