/**
 * The 90-Minute Feature Film Factory.
 *
 * One concept becomes an 18-scene feature. Each scene is rendered on its own and
 * lands in the Staging Vault for review, so a bad five minutes is re-rendered
 * alone instead of the whole picture. The batch engine feeds the scenes through
 * the T1/T2/T3 router one at a time, logs and skips a scene that fails, and only
 * stitches when the approved scenes are in hand.
 *
 * Rendering is injected (`renderScene`), so the engine can be exercised in tests
 * with a stand-in renderer and no GPU.
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifyTask, planExecution, route_to_cloud, type TaskRoute } from './taskRouter.ts';
import { saveAsset, assetPath, listAssets, type ReviewStatus } from './assets.ts';
import { concatCopy } from './render.ts';
import { saveRender, type StoredRender } from './renderStore.ts';
import { ORG_ID, type FactoryDb } from './factoryDb.ts';
import { buildConcept, buildScenes, mergeScenes, type ConceptOptions } from './featureFilm.ts';
import type { Mood } from '../movieMeta.ts';
import {
  FEATURE_SCENES, FEATURE_SCENE_SECONDS, FEATURE_TOTAL_SECONDS, filmClock,
  type MovieConcept, type FeatureScene, type SceneStatus,
} from '../featureFilm.ts';

/** One scene's place in the batch, for the UI. */
export interface SceneState {
  index: number;
  act: number;
  heading: string;
  beat: string;
  /** Tagalog voice-over for the scene. */
  narration: string;
  /** Short English description of the shot. */
  visual: string;
  mood: Mood;
  status: SceneStatus;
  percent: number;
  seconds: number;
  assetId?: string;
  assetName?: string;
  /** Public URL of the scene file in the local render store. */
  renderUrl?: string;
  error?: string;
  route: TaskRoute;
  startedAt?: number;
  endedAt?: number;
}

export type FeatureStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';

export interface FeatureJobView {
  id: string;
  /** The private vault this job belongs to (`LJRgroupORG`). */
  orgId: string;
  concept: MovieConcept;
  status: FeatureStatus;
  /** 0-100 across the whole film. */
  percent: number;
  rendered: number;
  failed: number;
  approved: number;
  rejected: number;
  total: number;
  totalSeconds: number;
  currentScene: number;
  /** Seconds already rendered, for the film clock. */
  renderedSeconds: number;
  scenes: SceneState[];
  /** The stitched film, once the batch is done and scenes were approved. */
  film?: { assetName: string; bytes: number; seconds: number; renderName?: string; renderUrl?: string };
  /** The Kaggle Pilot screenplay this film was built from, when one was fetched. */
  script?: string;
  /** The character bible the Pilot produced for the screenplay. */
  bible?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface SceneRenderInput {
  scene: FeatureScene;
  index: number;
}

/** What an injected renderer must return. */
export type SceneRenderer = (input: SceneRenderInput) => Promise<{ data: Buffer; seconds?: number; voiced?: boolean }>;

export interface FactoryDeps {
  renderScene: SceneRenderer;
  /** Whether ffmpeg is usable; when false the assembly step is skipped. */
  ffmpegAvailable: () => Promise<boolean>;
  /** Stitching backend. Defaults to the real `ffmpeg -c copy` concat. */
  concat?: (files: string[]) => Promise<{ data: Buffer }>;
  /** Local SQLite store for MovieJobs and SceneJobs. Optional (in-memory if absent). */
  db?: FactoryDb;
}

/** Which review states count as "done enough to stitch". */
const STITCHABLE: SceneStatus[] = ['approved'];

export class FeatureFactory {
  private jobs = new Map<string, FeatureJobView>();
  private queue: Promise<void> = Promise.resolve();
  private deps: FactoryDeps;

  constructor(deps: FactoryDeps) {
    this.deps = deps;
  }

  /** Persist one job to SQLite, when a database is wired in. */
  private persist(job: FeatureJobView): void {
    try {
      this.deps.db?.save(job);
    } catch {
      // The batch must not die because the local database hiccuped.
    }
  }

  /** Create a job from one brief; every field is derived when not given. */
  create(opts: ConceptOptions): FeatureJobView {
    const concept = buildConcept(opts);
    const scenes = buildScenes(concept, opts.mood);
    const id = `FILM-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const job: FeatureJobView = {
      id,
      orgId: ORG_ID,
      concept,
      status: 'idle',
      percent: 0,
      rendered: 0,
      failed: 0,
      approved: 0,
      rejected: 0,
      total: FEATURE_SCENES,
      totalSeconds: FEATURE_TOTAL_SECONDS,
      currentScene: 0,
      renderedSeconds: 0,
      scenes: scenes.map(s => this.sceneState(s)),
      startedAt: Date.now(),
    };
    this.jobs.set(id, job);
    while (this.jobs.size > 12) this.jobs.delete(this.jobs.keys().next().value as string);
    this.persist(job);
    return job;
  }

  private sceneState(scene: FeatureScene): SceneState {
    // Every scene is a 5-minute video, so it is T3 (heavy) and offloaded.
    const route = classifyTask('video_render');
    return {
      index: scene.index,
      act: scene.act,
      heading: scene.heading,
      beat: scene.beat,
      narration: scene.narration,
      visual: scene.visual,
      mood: scene.mood,
      status: 'pending',
      percent: 0,
      seconds: scene.seconds,
      route,
    };
  }

  /** True when a job belongs to this build's private vault. */
  private inVault(job: FeatureJobView): boolean {
    return job.orgId === ORG_ID;
  }

  /**
   * One job by id, or undefined when it is unknown or outside the vault. The
   * vault check keeps a shared process from serving another org's film to the
   * frontend.
   */
  get(id: string): FeatureJobView | undefined {
    const job = this.jobs.get(id);
    return job && this.inVault(job) ? job : undefined;
  }

  /** The newest job, for a UI that only shows one film. */
  latest(): FeatureJobView | undefined {
    let newest: FeatureJobView | undefined;
    for (const job of this.jobs.values()) {
      if (!this.inVault(job)) continue;
      if (!newest || job.startedAt > newest.startedAt) newest = job;
    }
    return newest;
  }

  list(): FeatureJobView[] {
    return [...this.jobs.values()]
      .filter(job => this.inVault(job))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Replace the scene list with a richer one (a model breakdown). */
  applyBreakdown(id: string, model: unknown): FeatureJobView | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const fallback = buildScenes(job.concept);
    const merged = mergeScenes(model, fallback, job.concept);
    job.scenes = merged.map(s => ({ ...this.sceneState(s), status: 'pending' as SceneStatus }));
    this.persist(job);
    return job;
  }

  /**
   * Attach the screenplay and character bible the Kaggle Pilot produced, and
   * fold the Pilot's scene breakdown onto the 18-beat plan. The Pilot only
   * supplies the text half; the factory still renders every scene for real.
   */
  applyScript(
    id: string,
    script: string,
    opts: { bible?: string; scenes?: unknown } = {},
  ): FeatureJobView | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.script = script;
    if (opts.bible) job.bible = opts.bible;
    if (opts.scenes) this.applyBreakdown(id, opts.scenes);
    this.persist(job);
    return job;
  }

  private scenesOf(job: FeatureJobView): FeatureScene[] {
    return job.scenes.map(s => ({
      index: s.index,
      act: s.act,
      heading: s.heading,
      beat: s.beat,
      narration: s.narration,
      visual: s.visual,
      mood: s.mood,
      seconds: s.seconds,
    }));
  }

  /**
   * Run the batch. Scenes are rendered one at a time, in order. A scene that
   * fails is logged, marked failed, and skipped; the batch continues.
   */
  start(id: string): FeatureJobView | undefined {
    const job = this.jobs.get(id);
    if (!job || job.status === 'running') return job;
    job.status = 'running';
    job.error = undefined;
    job.endedAt = undefined;
    this.persist(job);
    this.queue = this.queue.then(() => this.runBatch(job)).catch(() => {});
    return job;
  }

  pause(id: string): FeatureJobView | undefined {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return job;
    job.status = 'paused';
    this.persist(job);
    return job;
  }

  private recompute(job: FeatureJobView): void {
    job.rendered = job.scenes.filter(s => s.status === 'rendered' || s.status === 'approved').length;
    job.failed = job.scenes.filter(s => s.status === 'failed').length;
    job.approved = job.scenes.filter(s => s.status === 'approved').length;
    job.rejected = job.scenes.filter(s => s.status === 'rejected').length;
    job.renderedSeconds = job.scenes.filter(s => s.status === 'rendered' || s.status === 'approved').length * FEATURE_SCENE_SECONDS;
    const done = job.scenes.filter(s => s.status === 'rendered' || s.status === 'approved' || s.status === 'failed').length;
    job.percent = Math.round((done / job.total) * 100);
  }

  private async runBatch(job: FeatureJobView): Promise<void> {
    const scenes = this.scenesOf(job);
    const plan = planExecution('video_render');
    for (let i = 0; i < job.scenes.length; i++) {
      if (job.status !== 'running') return; // paused or stopped
      const state = job.scenes[i];
      if (state.status === 'rendered' || state.status === 'approved') continue;
      job.currentScene = state.index;
      state.status = 'rendering';
      state.startedAt = Date.now();
      state.percent = 10;
      this.persist(job);
      try {
        if (plan.run === 'cloud') {
          // T3 is offloaded; with no cloud worker configured it is queued, and
          // the scene is marked failed so the batch moves on rather than
          // secretly loading the local GPU.
          throw new Error(route_to_cloud('video_render', { scene: state.index }).note);
        }
        state.percent = 40;
        const out = await this.deps.renderScene({ scene: scenes[i], index: state.index });
        const seconds = out.seconds ?? state.seconds;
        state.percent = 90;
        const asset = saveAsset(out.data, {
          title: `Scene ${state.index} — ${job.concept.title}`,
          ext: 'mp4',
          mime: 'video/mp4',
          source: 'feature-film-factory',
          prompt: scenes[i].visual,
        });
        // The served copy lives in public/renders/ for playback and download.
        const stored: StoredRender = saveRender(out.data, `scene-${state.index}-${job.concept.title}`);
        state.assetId = asset.id;
        state.assetName = asset.name;
        state.renderUrl = stored.url;
        state.seconds = seconds;
        state.status = 'rendered';
        state.percent = 100;
        state.endedAt = Date.now();
      } catch (error: any) {
        // Fail-safe: log it, skip it, keep going.
        state.status = 'failed';
        state.percent = 100;
        state.error = error?.message || 'Nabigo ang render.';
        state.endedAt = Date.now();
      }
      this.recompute(job);
      this.persist(job);
    }
    job.currentScene = 0;
    // Assembly: stitch the approved scenes with `-c copy`.
    try {
      await this.assemble(job);
    } catch (error: any) {
      job.error = `Assembly: ${error?.message || 'error'}`;
    }
    job.status = 'done';
    job.endedAt = Date.now();
    this.persist(job);
  }

  /**
   * Stitch the approved scenes into one continuous feature, in scene order,
   * with the concat demuxer and `-c copy` (no re-encode). Needs at least two
   * approved scenes and a usable ffmpeg.
   */
  async assemble(job: FeatureJobView): Promise<FeatureJobView['film'] | undefined> {
    // Pick up the latest review decisions from the vault first.
    this.refresh(job.id);
    const approved = job.scenes
      .filter(s => STITCHABLE.includes(this.statusOf(s)))
      .sort((a, b) => a.index - b.index)
      .filter(s => s.assetName);
    if (approved.length < 2) return undefined;
    if (!(await this.deps.ffmpegAvailable())) {
      throw new Error('Walang ffmpeg, kaya hindi maidugtong ang mga eksena.');
    }
    const files: string[] = [];
    for (const s of approved) {
      const full = assetPath(s.assetName!);
      if (!full || !fs.existsSync(full)) throw new Error(`Nawawala ang eksena ${s.index} (${s.assetName}).`);
      files.push(full);
    }
    const joined = await (this.deps.concat ?? concatCopy)(files);
    const seconds = approved.length * FEATURE_SCENE_SECONDS;
    const asset = saveAsset(joined.data, {
      title: `${job.concept.title} (buong pelikula)`,
      ext: 'mp4',
      mime: 'video/mp4',
      source: 'feature-film-factory',
      prompt: job.concept.brief,
    });
    const stored = saveRender(joined.data, `feature-${job.concept.title}`);
    job.film = {
      assetName: asset.name,
      bytes: asset.bytes,
      seconds,
      renderName: stored.name,
      renderUrl: stored.url,
    };
    this.persist(job);
    return job.film;
  }

  /**
   * Stitch one film by id: gather its approved scene `.mp4`s in order and join
   * them with `ffmpeg -c copy` into a single continuous feature. Thin wrapper
   * over `assemble` so a caller only needs the movie id.
   */
  async stitchMovie(movieId: string): Promise<FeatureJobView['film'] | undefined> {
    const job = this.get(movieId) ?? this.deps.db?.load(movieId);
    if (!job) return undefined;
    if (!this.jobs.has(movieId)) this.jobs.set(movieId, job);
    return this.assemble(job);
  }

  /** A scene's review state, from its asset when it has one. */
  private statusOf(state: SceneState): SceneStatus {
    if (state.status === 'rendered' || state.status === 'approved' || state.status === 'rejected') {
      // A rendered scene may have been approved in the vault; reflect that.
      if (state.assetId) {
        const asset = listAssets().find(a => a.id === state.assetId);
        if (asset) {
          if (asset.reviewStatus === 'approved') return 'approved';
          if (asset.reviewStatus === 'rejected') return 'rejected';
        }
      }
      return state.status;
    }
    return state.status;
  }

  /** Sync the vault's review decisions back into the job view. */
  refresh(id: string): FeatureJobView | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    for (const state of job.scenes) {
      if (!state.assetId) continue;
      const asset = listAssets().find(a => a.id === state.assetId);
      if (!asset) continue;
      if (asset.reviewStatus === 'approved') state.status = 'approved';
      else if (asset.reviewStatus === 'rejected') state.status = 'rejected';
      else if (state.status === 'approved' || state.status === 'rejected') state.status = 'rendered';
    }
    this.recompute(job);
    this.persist(job);
    return job;
  }

  /** Re-render one scene on its own, then re-stitch the approved film. */
  async rerender(id: string, index: number): Promise<FeatureJobView | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const state = job.scenes.find(s => s.index === index);
    if (!state) return undefined;
    const scenes = this.scenesOf(job);
    const scene = scenes.find(s => s.index === index)!;
    state.status = 'rendering';
    state.percent = 10;
    state.error = undefined;
    this.persist(job);
    try {
      const out = await this.deps.renderScene({ scene, index });
      const asset = saveAsset(out.data, {
        title: `Scene ${index} — ${job.concept.title}`,
        ext: 'mp4',
        mime: 'video/mp4',
        source: 'feature-film-factory',
        prompt: scene.visual,
      });
      const stored = saveRender(out.data, `scene-${index}-${job.concept.title}`);
      state.assetId = asset.id;
      state.assetName = asset.name;
      state.renderUrl = stored.url;
      state.status = 'rendered';
      state.percent = 100;
    } catch (error: any) {
      state.status = 'failed';
      state.error = error?.message || 'Nabigo ang render.';
    }
    this.recompute(job);
    this.persist(job);
    return job;
  }
}

/** A one-line summary for the thought stream. */
export function factorySummary(job: FeatureJobView): string {
  return (
    `${job.concept.title} (${job.concept.genre}, ${job.concept.rating}, ${job.concept.format}) · ` +
    `${job.rendered}/${job.total} eksena · ${filmClock(job.renderedSeconds)} / ${filmClock(job.totalSeconds)} · ${job.status}`
  );
}
