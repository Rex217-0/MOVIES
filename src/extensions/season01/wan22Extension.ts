/**
 * Episode 3 as an extension: the Wan 2.2 render surface.
 *
 * The rendering itself is not duplicated here. `videoRenderService` already owns
 * the engine choice (PREFERRED_RENDER_ENGINE) and the free-first fallback chain,
 * so this module only adds the two things the operator was missing: a way to ask
 * whether Wan 2.2 is actually loadable right now, and a direct render endpoint
 * for a single clip that goes through that same engine.
 */

import type { ExtensionSkill, MovieCreatorExtension, RouteHost } from '../contract.ts';
import { checkWan22Status, wan22Models, wan22WorkflowPath } from './wan22Connector.ts';

export interface Wan22RenderBody {
  prompt?: unknown;
  negative?: unknown;
  resolution?: unknown;
  aspectRatio?: unknown;
  seconds?: unknown;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** The skill ids this extension owns, exported so the persona parity test can exclude them. */
export const WAN22_SKILLS = ['wan22_status'] as const;

const wan22Skill: ExtensionSkill = {
  id: 'wan22_status',
  does: 'Suriin kung abot ang ComfyUI at kung nakalista ang Wan 2.2 models (Server-2).',
  args: '{}',
  run: async () => checkWan22Status(),
};

export function createWan22Connector(): MovieCreatorExtension {
  return {
    id: 'season-01-wan22',
    name: 'Season 1 — Built-in Wan 2.2 ComfyUI Video Connector',
    season: 1,
    version: '1.0.0',
    enabled: process.env.SEASON01_WAN22 !== '0',
    skills: [wan22Skill],

    registerRoutes(app: RouteHost) {
      app.get('/api/extensions/season-01-wan22/status', async (_req: any, res: any) => {
        try {
          const status = await checkWan22Status();
          res.status(status.ok ? 200 : 503).json(status);
        } catch (error: any) {
          res.status(500).json({ ok: false, error: error?.message || String(error) });
        }
      });

      app.get('/api/extensions/season-01-wan22/workflow', (_req: any, res: any) => {
        res.json({
          workflow: wan22WorkflowPath(),
          models: wan22Models(),
          engine: (process.env.PREFERRED_RENDER_ENGINE || 'comfyui').toLowerCase(),
        });
      });

      app.post('/api/extensions/season-01-wan22/render', async (req: any, res: any) => {
        const body = (req.body ?? {}) as Wan22RenderBody;
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) {
          res.status(400).json({ ok: false, error: 'Kailangan ng prompt.' });
          return;
        }

        // Imported here, not at module load: a broken render service must not stop
        // the extension from mounting and reporting its own status.
        const service = await import('../../direk/videoRenderService.ts');
        try {
          const result = await service.renderVideo({
            prompt,
            negative: typeof body.negative === 'string' ? body.negative : undefined,
            resolution: typeof body.resolution === 'string' ? body.resolution : undefined,
            aspectRatio: typeof body.aspectRatio === 'string' ? body.aspectRatio : undefined,
            seconds: body.seconds !== undefined ? clampInt(body.seconds, 1, 30, 5) : undefined,
          });
          // The clip itself is binary; the JSON response describes it and hands
          // back a base64 payload so one request is enough for the UI.
          res.json({
            ok: true,
            engine: result.engine,
            credit: result.credit,
            sourceUrl: result.sourceUrl,
            licence: result.licence,
            bytes: result.data.length,
            mime: 'video/mp4',
            data_base64: result.data.toString('base64'),
          });
        } catch (error: any) {
          // A render that could not run is not a 200: the UI must not show a clip
          // that does not exist.
          const unavailable = error instanceof service.VideoBackendUnavailable;
          res.status(unavailable ? 503 : 500).json({
            ok: false,
            error: error?.message || String(error),
            backend_unavailable: unavailable,
          });
        }
      });
    },
  };
}
