/**
 * The Marilag batch runner.
 *
 * Queues the ten Marilag Originals and runs them one at a time: create the job,
 * render every scene, approve the scenes that rendered, stitch the film, then
 * move to the next movie. A movie that cannot render is marked failed with the
 * real reason and the batch continues; nothing is faked.
 *
 * This module does not talk to any external service. Publishing to CineStream or
 * MyStream is out of scope here: there is no such API in this repository, and a
 * batch that claims to have published without one would be lying.
 */

import {
  marilagMovies, marilagConceptOptions,
  MARILAG_MOVIES, MARILAG_SCENES, MARILAG_SECONDS,
  MARILAG_TARGET_SCENES, MARILAG_TARGET_SECONDS,
} from './marilag.ts';
import type { ConceptOptions } from './featureFilm.ts';

export interface BatchSceneLike {
  status: string;
  assetId?: string;
  error?: string;
}

export interface BatchJobLike {
  id: string;
  status: string;
  error?: string;
  scenes: BatchSceneLike[];
}

export interface MarilagBatchDeps {
  createJob(opts: ConceptOptions): { id: string };
  startJob(id: string): void;
  getJob(id: string): BatchJobLike | undefined;
  /** Mark a rendered scene's asset approved so it can be stitched. */
  approveScene(assetId: string, status: 'approved' | 'rejected'): void;
  stitch(id: string): Promise<{ assetName: string; bytes: number; seconds: number } | undefined>;
  now?: () => number;
  /** How long to wait for one movie's scenes before calling it stuck. */
  movieTimeoutMs?: number;
}

export type MarilagItemStatus = 'queued' | 'rendering' | 'stitching' | 'done' | 'failed';

export interface MarilagBatchItem {
  index: number;
  title: string;
  genre: string;
  movieId?: string;
  status: MarilagItemStatus;
  scenesTotal: number;
  scenesRendered: number;
  filmBytes?: number;
  assetName?: string;
  error?: string;
}

export interface MarilagBatchView {
  id: string;
  status: 'idle' | 'running' | 'done' | 'error';
  createdAt: number;
  updatedAt: number;
  movies: MarilagBatchItem[];
  /** Plain-language truth about what this batch does and does not do. */
  note: string;
}

export const MARILAG_BATCH_NOTE =
  'Bawat pelikula ay sunod-sunod na render sa ComfyUI. Ang bilang ng eksena ay ' +
  'sumusunod sa engine: ' + MARILAG_SCENES + ' eksena x 5 minuto = ' +
  MARILAG_SECONDS / 60 + ' minuto bawat pelikula (target: ' + MARILAG_TARGET_SCENES +
  ' eksena / ' + MARILAG_TARGET_SECONDS / 60 + ' minuto). Hindi ito nag-publish sa ' +
  'CineStream o MyStream: walang ganoong API sa repo na ito, kaya walang ipinadalang ' +
  'video sa labas. Ang isang pelikulang hindi makapag-render ay nabibigo nang may ' +
  'totoong dahilan.';

/**
 * Run the batch: one movie at a time, in order. `batch` is mutated in place so a
 * status endpoint sees live progress.
 */
export async function runMarilagBatch(
  batch: MarilagBatchView,
  deps: MarilagBatchDeps,
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const movies = marilagMovies();

  for (const item of batch.movies) {
    if (batch.status !== 'running') break;
    const concept = marilagConceptOptions(movies[item.index - 1]);
    item.status = 'rendering';
    batch.updatedAt = now();

    const job = deps.createJob(concept);
    item.movieId = job.id;
    deps.startJob(job.id);

    const settled = await waitForMovie(deps, job.id, deps.movieTimeoutMs ?? 60 * 60 * 1000);
    if (!settled) {
      item.status = 'failed';
      item.error = 'hindi natapos ang render sa loob ng itinakdang oras';
      batch.updatedAt = now();
      continue;
    }

    const rendered = settled.scenes.filter(s => s.status === 'rendered' && s.assetId);
    item.scenesRendered = rendered.length;

    if (!rendered.length) {
      item.status = 'failed';
      item.error =
        settled.error ||
        settled.scenes.find(s => s.error)?.error ||
        'walang na-render na eksena';
      batch.updatedAt = now();
      continue;
    }

    // Approve what actually rendered so the film can be stitched. A human can
    // still reject a scene in the Staging Vault; the batch only approves scenes
    // that reached 'rendered', never a failed one.
    for (const scene of rendered) deps.approveScene(scene.assetId!, 'approved');

    item.status = 'stitching';
    batch.updatedAt = now();
    try {
      const film = await deps.stitch(job.id);
      if (!film) {
        item.status = 'failed';
        item.error = 'kulang ang aprubadong eksena o walang ffmpeg para idugtong';
      } else {
        item.status = 'done';
        item.filmBytes = film.bytes;
        item.assetName = film.assetName;
      }
    } catch (error: any) {
      item.status = 'failed';
      item.error = error?.message || 'nabigo ang pagdugtong';
    }
    batch.updatedAt = now();
  }

  batch.status = batch.movies.every(m => m.status === 'done') ? 'done' : 'error';
  batch.updatedAt = now();
}

/** Poll a movie until it stops running and nothing is mid-render. */
async function waitForMovie(
  deps: MarilagBatchDeps,
  id: string,
  timeoutMs: number,
): Promise<BatchJobLike | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = deps.getJob(id);
    if (!job) return undefined;
    const rendering = job.scenes.some(s => s.status === 'rendering');
    if (job.status !== 'running' && !rendering) return job;
    await new Promise(r => setTimeout(r, 25));
  }
  return undefined;
}

/** A fresh batch in the idle state, ready to run. */
export function newMarilagBatch(now: () => number = () => Date.now()): MarilagBatchView {
  const movies = marilagMovies().map<MarilagBatchItem>(m => ({
    index: m.index,
    title: m.title,
    genre: m.genre,
    status: 'queued',
    scenesTotal: MARILAG_SCENES,
    scenesRendered: 0,
  }));
  const at = now();
  return {
    id: `MARILAG-${new Date(at).toISOString().replace(/[:.]/g, '-')}`,
    status: 'idle',
    createdAt: at,
    updatedAt: at,
    movies,
    note: MARILAG_BATCH_NOTE,
  };
}

export { MARILAG_MOVIES, MARILAG_SCENES, MARILAG_SECONDS, MARILAG_TARGET_SCENES, MARILAG_TARGET_SECONDS };
