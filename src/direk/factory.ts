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
import { saveAsset, assetPath, listAssets, supersedeAsset, type ReviewStatus } from './assets.ts';
import type { ComfyRenderFacts } from './comfyui.ts';
import {
  STITCHABLE_DISPOSITIONS,
  originalityProvenance,
  type AssetProvenance,
  type OriginalityProvenance,
  type VaultDisposition,
} from './provenance.ts';
import {
  acceptsMediaClass, parseQualityTier, requiresMasterBackend,
  MASTER_BACKEND_UNAVAILABLE_CODE, masterRefusalReason,
  type MediaClass, type QualityTier,
} from './mediaClass.ts';
import { concatCopy } from './render.ts';
import { saveRender, type StoredRender } from './renderStore.ts';
import { ORG_ID, type FactoryDb } from './factoryDb.ts';
import { sceneAccounting, sumAccounting, type JobAccounting } from './accounting.ts';
import { buildConcept, buildScenes, mergeScenes, type ConceptOptions } from './featureFilm.ts';
import type { Mood } from '../movieMeta.ts';
import {
  FEATURE_SCENES, FEATURE_SCENE_SECONDS, FEATURE_TOTAL_SECONDS, filmClock,
  type MovieConcept, type FeatureScene, type SceneStatus,
} from '../featureFilm.ts';

/**
 * The four pipeline stages the Commander tracks for each scene, in order.
 * `scripting` is the plan/shot list, `rendering` is the ComfyUI picture,
 * `audio` is the narration + music mix, `completed` is a finished scene.
 */
export type SceneStage = 'scripting' | 'rendering' | 'audio' | 'completed' | 'blocked';

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
  /** Which pipeline stage the scene is in, so the UI shows real progress. */
  stage: SceneStage;
  percent: number;
  seconds: number;
  /** What the file on disk actually is, once it exists. */
  mediaClass?: MediaClass;
  /** The block state when the quality tier refused a weaker engine. */
  blockedReason?: string;
  /** The shots this scene was cut into, so the UI can show the cut. */
  shots?: { index: number; framing: string; seconds: number }[];
  /** The renderer's own claim that this scene carries narration. */
  voiced?: boolean;
  assetId?: string;
  assetName?: string;
  /** Public URL of the scene file in the local render store. */
  renderUrl?: string;
  error?: string;
  route: TaskRoute;
  startedAt?: number;
  endedAt?: number;
  /**
   * What this scene cost to make. Measured, not labelled: the old UI called a
   * local GPU render "FREE", which was never true.
   */
  accounting?: JobAccounting;
}

export type FeatureStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';

export interface FeatureJobView {
  id: string;
  /** The private vault this job belongs to (`LJRgroupORG`). */
  orgId: string;
  concept: MovieConcept;
  /**
   * What this job promised. Fixed at creation: a job cannot be promoted to
   * MASTER later, because the scenes already rendered would not qualify.
   */
  qualityTier: QualityTier;
  /**
   * The Section 7 declaration for this film, fixed at creation like the tier.
   * Every asset the job produces copies it, so the claim travels with the bytes.
   */
  originality: OriginalityProvenance;
  status: FeatureStatus;
  /** 0-100 across the whole film. */
  percent: number;
  rendered: number;
  failed: number;
  /** Scenes the quality tier refused: a weaker clip was offered and not taken. */
  blocked: number;
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
  /** The film-level rollup of every scene's accounting. */
  accounting?: JobAccounting;
}

export interface SceneRenderInput {
  scene: FeatureScene;
  index: number;
  /** The tier the job promised, so the renderer never returns a weaker clip. */
  qualityTier: QualityTier;
  /** The renderer reports each pipeline stage as it reaches it. */
  onStage?: (stage: SceneStage) => void;
}

/**
 * What an injected renderer must return. `mediaClass` is required: a renderer
 * cannot say "done" without saying what the bytes are, which is what stops a
 * still-motion fallback from being reported as a synthetic render.
 */
export type SceneRenderer = (input: SceneRenderInput) => Promise<{
  data: Buffer;
  seconds?: number;
  voiced?: boolean;
  mediaClass: MediaClass;
  backend?: string;
  /** The shots the renderer cut the scene into, in film order. */
  shots?: { index: number; framing: string; seconds: number }[];
  /**
   * The seed, dimensions and graph the picture was rendered with. Absent for
   * engines that report none, and recorded as absent rather than guessed.
   */
  render?: ComfyRenderFacts;
  /** Which model or workflow version produced the picture. */
  modelOrWorkflowVersion?: string;
  /** The seed of every shot that was cut into this scene, in shot order. */
  seeds?: number[];
  /**
   * The renderer's own measurement of the work, when it has one. The factory
   * adds the retry count itself, so the renderer never has to know about it.
   */
  accounting?: Partial<Pick<JobAccounting, 'renderDurationMs' | 'externalApiCalls' | 'storageBytes'>>;
}>;

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

/**
 * Turn what a renderer reported into the sidecar's provenance block.
 *
 * Only what the renderer actually said is written. A renderer that reports no
 * seed leaves `seed` absent, which the vault shows as unknown — the honest
 * answer, and one a later re-render can read as "not reproducible from record".
 */
function sceneProvenance(out: {
  mediaClass: MediaClass;
  backend?: string;
  render?: ComfyRenderFacts;
  modelOrWorkflowVersion?: string;
  voiced?: boolean;
  seconds?: number;
  seeds?: number[];
}): AssetProvenance {
  const facts = out.render;
  const resolution =
    facts?.width && facts?.height ? `${facts.width}x${facts.height}` : undefined;
  // A scene cut from several shots has no single seed, so only a one-shot render
  // records `seed`; the rest record the list.
  const seeds = out.seeds?.length ? out.seeds : undefined;
  return {
    backend: out.backend,
    mediaClass: out.mediaClass,
    // The checkpoint is the closest thing to a model version the graph carries,
    // so it is recorded alongside the workflow file that shaped it.
    modelOrWorkflowVersion:
      out.modelOrWorkflowVersion ??
      (facts?.checkpoint && facts?.workflow
        ? `${facts.checkpoint} (${facts.workflow})`
        : facts?.checkpoint ?? facts?.workflow),
    seed: seeds ? (seeds.length === 1 ? seeds[0] : undefined) : facts?.seed,
    seeds: seeds && seeds.length > 1 ? seeds : undefined,
    resolution,
    framesDuration:
      facts?.frames || out.seconds
        ? { frames: facts?.frames, seconds: out.seconds }
        : undefined,
    // `voiced` is the renderer's own claim about its audio, so it is what gets
    // recorded: a silent scene must not read as narrated.
    audioState: out.voiced === undefined ? undefined : out.voiced ? 'voiced' : 'silent',
    sourceLicense: undefined,
  };
}

/**
 * How long a running film keeps its claim without a renewal. A single scene can
 * take a long time on CPU, so this is generous; its job is only to be finite, so
 * a process that died stops holding the queue.
 */
const LEASE_TTL_MS = 30 * 60 * 1000;

export class FeatureFactory {
  private jobs = new Map<string, FeatureJobView>();
  private queue: Promise<void> = Promise.resolve();
  private deps: FactoryDeps;
  /**
   * Who this process is on the queue ledger. Unique per factory instance, so a
   * second process (or a restarted one) can tell its rows from a dead one's.
   */
  private holder = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private draining = false;
  private drainPromise: Promise<void> | undefined;

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
  create(
    opts: ConceptOptions & { qualityTier?: QualityTier | string; originality?: OriginalityProvenance },
  ): FeatureJobView {
    const concept = buildConcept(opts);
    const scenes = buildScenes(concept, opts.mood);
    const id = `FILM-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const job: FeatureJobView = {
      id,
      orgId: ORG_ID,
      concept,
      qualityTier: parseQualityTier(opts.qualityTier),
      // The declaration is fixed at creation with the tier. `create` never
      // consults the catalog itself, so a job made here records "no grounding"
      // rather than inheriting a claim made by a different code path.
      originality: opts.originality ?? originalityProvenance(),
      status: 'idle',
      percent: 0,
      rendered: 0,
      failed: 0,
      blocked: 0,
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
      stage: 'scripting',
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
   *
   * START goes through the ledger first. Only the claim holder runs the film, so
   * pressing START on the same film twice cannot produce two batches racing for
   * the same shots, and a second film waits its turn instead of interleaving
   * scenes into the same GPU.
   */
  start(id: string): FeatureJobView | undefined {
    const job = this.jobs.get(id);
    if (!job || job.status === 'running') return job;

    // Mark it running before the scheduler is kicked, so the very next poll sees
    // the truth and never reports a film that is queued as still idle.
    job.status = 'running';
    job.error = undefined;
    job.endedAt = undefined;
    this.persist(job);

    // No database means an in-memory build (tests, a bare engine): fall back to
    // the promise chain, which is still one-at-a-time within this process.
    if (!this.deps.db) {
      this.queue = this.queue.then(() => this.runBatch(job)).catch(() => {});
      return job;
    }

    // A finished, failed, or cancelled film is re-queued when START is pressed
    // again: it keeps its rendered scenes and resumes at the first one missing.
    this.deps.db.enqueue(id, { holder: this.holder, requeue: true });
    this.scheduler();
    return job;
  }

  /**
   * Drain the queue, one film at a time, until nothing is left to claim.
   *
   * This is the scheduler. It is a loop rather than a callback because the queue
   * lives in SQLite: whoever calls it may be a fresh process after a crash, and
   * the loop simply picks up whatever is queued next.
   */
  private scheduler(): void {
    if (this.draining) return;
    this.draining = true;
    // Without this catch, one bad film took the whole server down: a SQLite
    // "database is locked" thrown from `finish()` became an unhandled rejection
    // and killed the process mid-render, losing every other queued film.
    this.drainPromise = this.drain()
      .catch(error => {
        console.error('[direk] scheduler stopped:', error);
        this.abandonAfterFailure(error);
      })
      .finally(() => {
        this.draining = false;
      });
  }

  /**
   * Hand back what a failed drain was holding.
   *
   * `drain()` claims a film before it runs it, and the claim is only released
   * when the batch finishes. If the batch throws instead, the film keeps a live
   * lease and stays `running`: START refuses to re-enter a running film, so the
   * UI sat at 0% until the lease expired. Releasing the claim here lets the next
   * START (or the next process) pick the film up straight away.
   */
  private abandonAfterFailure(error: unknown): void {
    // The in-memory view is what the UI polls, and `start()` refuses to re-enter
    // a running film. Leaving it `running` after the batch is gone is the bar
    // that never moves, whether or not a database is wired in.
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        job.status = 'paused';
        job.error = (error as any)?.message || 'Nahinto ang scheduler.';
        this.persist(job);
      }
    }
    const db = this.deps.db;
    if (!db) return;
    const locked = (error as any)?.errcode === 5 || (error as any)?.code === 'ERR_SQLITE_ERROR';
    if (locked) {
      // The connection cannot write right now, so the release itself would fail.
      // The lease still expires, and `recoverAbandoned` clears it on next boot.
      return;
    }
    try {
      db.releaseHeld(this.holder);
    } catch (releaseError) {
      console.error('[direk] could not release the failed film:', releaseError);
    }
  }

  private async drain(): Promise<void> {
    const db = this.deps.db;
    if (!db) return;
    for (;;) {
      const claimed = db.claimNext(this.holder, { ttlMs: LEASE_TTL_MS });
      if (!claimed) return;
      const job = this.get(claimed.movieId) ?? db.load(claimed.movieId);
      if (!job) {
        // The queue row outlived its film: finish it so it cannot block the head
        // of the queue forever.
        db.finish(claimed.movieId, this.holder, 'failed');
        continue;
      }
      this.jobs.set(job.id, job);
      if (job.status === 'done' || job.status === 'error') {
        db.finish(job.id, this.holder, 'done');
        continue;
      }
      const lease = setInterval(() => {
        db.renewLease(job.id, this.holder, { ttlMs: LEASE_TTL_MS });
      }, Math.max(1000, Math.floor(LEASE_TTL_MS / 2)));
      lease.unref?.();
      try {
        job.status = 'running';
        job.error = undefined;
        job.endedAt = undefined;
        this.persist(job);
        await this.runBatch(job);
      } finally {
        clearInterval(lease);
        // `runBatch` decides the final status, so it is read back through the
        // declared type rather than the 'running' TypeScript narrowed above.
        const finalStatus = job.status as FeatureStatus;
        try {
          // A cancelled film keeps its progress but stops being "running", and
          // its queue row is already 'cancelled', so the ledger is left as is.
          if (db.isCancelled(job.id)) {
            job.status = 'paused';
            this.persist(job);
            db.finish(job.id, this.holder, 'cancelled');
          } else {
            db.finish(job.id, this.holder, finalStatus === 'done' ? 'done' : 'failed');
          }
        } catch (error) {
          // The lease keeps its old expiry, so boot-time recovery reclaims this
          // film. Losing the bookkeeping must not lose the rest of the queue.
          console.error(`[direk] could not close lease for ${job.id}:`, error);
        }
      }
    }
  }

  /** Resolves when the scheduler has nothing left to run. Used by tests. */
  whenIdle(): Promise<void> {
    return this.drainPromise ?? Promise.resolve();
  }

  /**
   * Pick up where a previous process stopped. Called once at boot.
   *
   * A crash cannot be prevented, so the recovery rule is what matters: a film
   * that was `running` when the process died has a stale lease, and its scene
   * that was mid-render is put back to `pending`. The film goes back to the head
   * of the queue and renders again from that scene. Everything already rendered
   * stays rendered, so a crash costs at most the one scene in flight.
   *
   * Nothing resumes on its own. Recovery only makes the work claimable again;
   * the operator still presses START, so a boot loop cannot start a render loop.
   */
  recover(): string[] {
    const db = this.deps.db;
    if (!db) return [];
    const recovered = db.recoverAbandoned();
    for (const id of recovered) {
      // Drop the stale in-memory copy so the next read comes from the database.
      this.jobs.delete(id);
      console.error(`[FILM RECOVERY] "${id}" was interrupted; its unfinished scene is pending again.`);
    }
    return recovered;
  }

  pause(id: string): FeatureJobView | undefined {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return job;
    job.status = 'paused';
    this.persist(job);
    // The scene stays completed; only the batch stops. Cancelling at the ledger
    // level is what tells the running loop to stop after the current scene.
    this.deps.db?.requestCancel(id);
    return job;
  }

  /**
   * How many times this scene has already been attempted, from the ledger.
   * A first attempt is 0, so the number means "retries", not "tries".
   */
  private attemptsOf(job: FeatureJobView, index: number): number {
    const attempts = this.deps.db?.sceneAttempts(job.id, index);
    return Math.max(0, (attempts ?? 1) - 1);
  }

  /**
   * Fold every scene's accounting into the film-level total.
   *
   * A film with nothing rendered yet has no accounting at all, rather than a
   * zeroed one: "0 vendor calls" is a measurement, and nothing has run yet.
   */
  private rollupAccounting(job: FeatureJobView): void {
    const parts = job.scenes.map(s => s.accounting).filter((a): a is JobAccounting => Boolean(a));
    job.accounting = parts.length ? sumAccounting(parts) : undefined;
  }

  private recompute(job: FeatureJobView): void {
    job.rendered = job.scenes.filter(s => s.status === 'rendered' || s.status === 'approved').length;
    job.failed = job.scenes.filter(s => s.status === 'failed').length;
    job.blocked = job.scenes.filter(s => s.status === 'blocked').length;
    job.approved = job.scenes.filter(s => s.status === 'approved').length;
    job.rejected = job.scenes.filter(s => s.status === 'rejected').length;
    job.renderedSeconds = job.scenes.filter(s => s.status === 'rendered' || s.status === 'approved').length * FEATURE_SCENE_SECONDS;
    const done = job.scenes.filter(
      s => s.status === 'rendered' || s.status === 'approved' || s.status === 'failed' || s.status === 'blocked',
    ).length;
    job.percent = Math.round((done / job.total) * 100);
    this.rollupAccounting(job);
  }

  private async runBatch(job: FeatureJobView): Promise<void> {
    const scenes = this.scenesOf(job);
    const plan = planExecution('video_render');
    for (let i = 0; i < job.scenes.length; i++) {
      if (job.status !== 'running') return; // paused or stopped
      // A stop asked for from another process is visible only in the ledger, so
      // check it per scene: the scene in flight finishes, nothing new starts.
      if (this.deps.db?.isCancelled(job.id)) {
        job.status = 'paused';
        this.persist(job);
        return;
      }
      const state = job.scenes[i];
      if (state.status === 'rendered' || state.status === 'approved') continue;
      // Claim the shot before rendering it. A scene already claimed by someone
      // else is skipped, not rendered twice into the same asset slot.
      const claimed = this.deps.db
        ? this.deps.db.claimScene(job.id, state.index, this.holder, { ttlMs: LEASE_TTL_MS })
        : true;
      if (!claimed) continue;
      job.currentScene = state.index;
      state.status = 'rendering';
      state.stage = 'rendering';
      state.startedAt = Date.now();
      state.percent = 10;
      this.persist(job);
      try {
        if (plan.run === 'cloud') {
          // A non-video T3 task (large TTS, massive LoRA) is offloaded; with no
          // cloud worker configured it is queued, and the scene is marked failed
          // so the batch moves on rather than secretly loading the local GPU.
          // Video itself is always local, so this branch never fires for it.
          throw new Error(route_to_cloud('video_render', { scene: state.index }).note);
        }
        state.percent = 40;
        const out = await this.deps.renderScene({
          scene: scenes[i],
          index: state.index,
          qualityTier: job.qualityTier,
          // Mirror the renderer's real sub-stage (ComfyUI picture, then audio
          // mix) onto the scene so the UI's four bars are honest.
          onStage: stage => {
            state.stage = stage;
            state.percent = stage === 'audio' ? 80 : state.percent;
            this.persist(job);
          },
        });
        // The renderer says what it made; the job decides whether that is what it
        // promised. A MASTER job handed a still-motion clip is refused here rather
        // than stitched into the film and reported as a synthetic render.
        const verdict = acceptsMediaClass(job.qualityTier, out.mediaClass);
        if (!verdict.accepted) {
          state.status = 'blocked';
          state.stage = 'blocked' as SceneStage;
          state.blockedReason = verdict.reason;
          state.error = verdict.reason;
          state.percent = 100;
          state.endedAt = Date.now();
          console.error(
            `[FILM BLOCKED] Eksena ${state.index} ("${state.heading}"): ` +
              `${job.qualityTier} ay tumanggap ng ${out.mediaClass}. ${verdict.reason}`,
          );
          this.recompute(job);
          this.persist(job);
          continue;
        }
        state.mediaClass = out.mediaClass;
        state.shots = out.shots;
        state.voiced = out.voiced;
        const seconds = out.seconds ?? state.seconds;
        // Measured on the way out: duration and vendor calls come from the
        // renderer, storage from the bytes we are about to write.
        state.accounting = sceneAccounting({
          engine: out.backend || 'comfyui',
          seconds,
          durationMs: out.accounting?.renderDurationMs ?? (Date.now() - (state.startedAt ?? Date.now())),
          externalApiCalls: out.accounting?.externalApiCalls ?? 0,
          storageBytes: out.data.length,
          retryCount: this.attemptsOf(job, state.index),
        });
        state.percent = 90;
        const asset = saveAsset(out.data, {
          title: `Scene ${state.index} — ${job.concept.title}`,
          ext: 'mp4',
          mime: 'video/mp4',
          source: 'feature-film-factory',
          prompt: scenes[i].visual,
          mediaClass: out.mediaClass,
          qualityTier: job.qualityTier,
          backend: out.backend,
          provenance: sceneProvenance(out),
          originality: job.originality,
        });
        // The served copy lives in public/renders/ for playback and download.
        const stored: StoredRender = saveRender(out.data, `scene-${state.index}-${job.concept.title}`);
        state.assetId = asset.id;
        state.assetName = asset.name;
        state.renderUrl = stored.url;
        state.seconds = seconds;
        state.status = 'rendered';
        state.stage = 'completed';
        state.percent = 100;
        state.endedAt = Date.now();
      } catch (error: any) {
        // A policy stand-down is not a crash: mark it blocked so the operator
        // sees "refused on purpose", not "retry me".
        const refusal = masterRefusalReason(error);
        if (refusal) {
          state.status = 'blocked';
          state.stage = 'blocked' as SceneStage;
          state.blockedReason = refusal;
          state.error = refusal;
          state.percent = 100;
          state.endedAt = Date.now();
          console.error(`[FILM BLOCKED] Eksena ${state.index} ("${state.heading}"): ${refusal}`);
          this.recompute(job);
          this.persist(job);
          continue;
        }
        // Fail-safe: log it, skip it, keep going.
        state.status = 'failed';
        state.percent = 100;
        state.error = error?.message || 'Nabigo ang render.';
        state.endedAt = Date.now();
        console.error(`[FILM ERROR] Eksena ${state.index} ("${state.heading}") nabigo: ${state.error}`);
      } finally {
        // Hand the shot back whether it rendered or failed: a lease kept past the
        // attempt would make the scene unclaimable by the next run.
        this.deps.db?.releaseScene(job.id, state.index);
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
    // The film is an assembly, not a render: it inherits its scenes' tier and
    // states that it was stitched, rather than claiming a backend or seed of its
    // own that no engine ever produced.
    const asset = saveAsset(joined.data, {
      title: `${job.concept.title} (buong pelikula)`,
      ext: 'mp4',
      mime: 'video/mp4',
      source: 'feature-film-factory',
      prompt: job.concept.brief,
      qualityTier: job.qualityTier,
      provenance: {
        backend: 'ffmpeg-concat',
        mediaClass: 'HYBRID',
        qualityTier: job.qualityTier,
        modelOrWorkflowVersion: `ffmpeg -c copy, ${approved.length} eksena`,
        framesDuration: { seconds },
        // The film is voiced only when every stitched scene said it was; one
        // silent scene makes the whole cut partly silent, and claiming
        // otherwise would overstate the asset.
        audioState: approved.every(s => s.voiced) ? 'voiced' : 'silent',
      },
      originality: job.originality,
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

  /**
   * A scene's review state, from its asset when it has one.
   *
   * Only `APPROVED_MASTER` makes a scene stitchable. A preview-only approval is
   * deliberately left as `rendered`: it is good enough to look at and not good
   * enough to become part of the film, and collapsing it to `approved` would
   * put it in the master cut. `REFINE` also stays `rendered` because it asks
   * for another render, not for a rejection.
   */
  private statusOf(state: SceneState): SceneStatus {
    if (state.status !== 'rendered' && state.status !== 'approved' && state.status !== 'rejected') {
      return state.status;
    }
    if (!state.assetId) return state.status;
    const asset = listAssets().find(a => a.id === state.assetId);
    if (!asset) return state.status;
    if (STITCHABLE_DISPOSITIONS.includes(asset.disposition)) return 'approved';
    if (
      asset.disposition === 'REJECTED_TECHNICAL' ||
      asset.disposition === 'REJECTED_CREATIVE' ||
      asset.disposition === 'SUPERSEDED'
    ) {
      return 'rejected';
    }
    return 'rendered';
  }

  /** Sync the vault's review decisions back into the job view. */
  refresh(id: string): FeatureJobView | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    for (const state of job.scenes) {
      if (!state.assetId) continue;
      const asset = listAssets().find(a => a.id === state.assetId);
      if (!asset) continue;
      // Reuse the one mapping so the vault view and the stitcher cannot disagree
      // about whether a scene is part of the film.
      state.status = this.statusOf({ ...state, status: 'rendered' });
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
    state.stage = 'rendering';
    state.percent = 10;
    state.error = undefined;
    state.blockedReason = undefined;
    this.persist(job);
    try {
      const out = await this.deps.renderScene({
        scene,
        index,
        qualityTier: job.qualityTier,
        onStage: stage => {
          state.stage = stage;
          state.percent = stage === 'audio' ? 80 : state.percent;
          this.persist(job);
        },
      });
      const verdict = acceptsMediaClass(job.qualityTier, out.mediaClass);
      if (!verdict.accepted) {
        state.status = 'blocked';
        state.stage = 'blocked';
        state.blockedReason = verdict.reason;
        state.error = verdict.reason;
        state.percent = 100;
        state.endedAt = Date.now();
        this.recompute(job);
        this.persist(job);
        return job;
      }
      state.mediaClass = out.mediaClass;
      state.shots = out.shots;
      state.voiced = out.voiced;
      const previousAssetId = state.assetId;
      const asset = saveAsset(out.data, {
        title: `Scene ${index} — ${job.concept.title}`,
        ext: 'mp4',
        mime: 'video/mp4',
        source: 'feature-film-factory',
        prompt: scene.visual,
        mediaClass: out.mediaClass,
        qualityTier: job.qualityTier,
        backend: out.backend,
        provenance: { ...sceneProvenance(out), parentAssetId: previousAssetId },
        originality: job.originality,
      });
      // The old render is retired, not deleted: the chain from the superseded
      // asset to this one is the only record of what was replaced and why.
      if (previousAssetId) {
        supersedeAsset(previousAssetId, asset.id, {
          reason: `Re-render ng eksena ${index}.`,
        });
      }
      const stored = saveRender(out.data, `scene-${index}-${job.concept.title}`);
      state.assetId = asset.id;
      state.assetName = asset.name;
      state.renderUrl = stored.url;
      state.status = 'rendered';
      state.stage = 'completed';
      state.percent = 100;
    } catch (error: any) {
      const refusal = masterRefusalReason(error);
      if (refusal) {
        state.status = 'blocked';
        state.stage = 'blocked' as SceneStage;
        state.blockedReason = refusal;
        state.error = refusal;
        console.error(`[FILM BLOCKED] Eksena ${index} ("${scene.heading}"): ${refusal}`);
      } else {
        state.status = 'failed';
        state.error = error?.message || 'Nabigo ang render.';
        console.error(`[FILM ERROR] Eksena ${index} ("${scene.heading}") nabigo: ${state.error}`);
      }
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
