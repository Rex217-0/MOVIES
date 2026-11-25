import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Clapperboard, Download, Film, Layers, Loader2, Pause, Play, RefreshCw, Sparkles, TriangleAlert,
} from 'lucide-react';
import {
  assetDownloadUrl, featureAssemble, featureCreate, featurePause, featurePilot, featureRerender,
  featureStart, featureStatus,
  type FeatureJobView, type FeatureSceneView, type FeatureStatus,
} from '../api';

const IDEAS = [
  'Isang mangingisda sa probinsya na may nakatagong lihim, SPG, Realistic.',
  'Horror sa masukal na gubat: may sumusunod sa mga bisita, R, Realistic.',
  'Romance sa palengke ng Maynila na may kantang hindi matapos, PG, Realistic.',
  'Sci-fi sa isang kolonya sa Mars na nauubusan ng tubig, PG, Animated.',
];

function bytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const SCENE_LABEL: Record<FeatureSceneView['status'], string> = {
  pending: 'naghihintay',
  rendering: 'ginagawa',
  rendered: 'tapos — hintay ng review',
  approved: 'aprubado',
  rejected: 'tinanggihan',
  failed: 'bigo',
};

/** The four pipeline stages each scene passes through, in order. */
const STAGES: { key: FeatureSceneView['stage']; label: string }[] = [
  { key: 'scripting', label: 'Scripting' },
  { key: 'rendering', label: 'Rendering' },
  { key: 'audio', label: 'Audio' },
  { key: 'completed', label: 'Completed' },
];

function stageIndex(stage: FeatureSceneView['stage']): number {
  return Math.max(0, STAGES.findIndex(s => s.key === stage));
}

export function FeatureFilmFactory() {
  const [status, setStatus] = useState<FeatureStatus | null>(null);
  const [job, setJob] = useState<FeatureJobView | null>(null);
  const [brief, setBrief] = useState('');
  const [title, setTitle] = useState('');
  const [genre, setGenre] = useState('');
  const [rating, setRating] = useState('');
  const [format, setFormat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pilotSource, setPilotSource] = useState('');
  const alive = useRef(true);

  const load = useCallback((id?: string) => {
    featureStatus(id).then(s => {
      if (!alive.current) return;
      setStatus(s);
      if (s.job) setJob(s.job);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    alive.current = true;
    load(job?.id);
    return () => { alive.current = false; };
  }, [load, job?.id]);

  // Poll while the batch is working; stop once it settles.
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const id = setInterval(() => load(job.id), 2000);
    return () => clearInterval(id);
  }, [job, load]);

  const makeConcept = async () => {
    const text = brief.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await featureCreate({
        brief: text,
        title: title.trim() || undefined,
        genre: genre.trim() || undefined,
        rating: rating || undefined,
        format: format || undefined,
      });
      setJob(created);
    } catch (e: any) {
      setError(e?.message || 'Hindi nagawa ang concept.');
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!job || busy) return;
    setBusy(true);
    setError('');
    try {
      setJob(await featureStart(job.id));
    } catch (e: any) {
      setError(e?.message || 'Hindi nag-start ang batch.');
    } finally {
      setBusy(false);
    }
  };

  const fetchPilot = async () => {
    if (!job || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await featurePilot(job.id);
      setJob(result.job);
      setPilotSource(result.source === 'kaggle' ? 'Kaggle (T3)' : `local Ollama (${result.model})`);
    } catch (e: any) {
      setError(e?.message || 'Hindi maabot ang Pilot (Kaggle o local Ollama).');
    } finally {
      setBusy(false);
    }
  };

  const pause = async () => {
    if (!job || busy) return;
    setBusy(true);
    try {
      setJob(await featurePause(job.id));
    } catch (e: any) {
      setError(e?.message || 'Hindi nag-pause ang batch.');
    } finally {
      setBusy(false);
    }
  };

  const rerender = async (index: number) => {
    if (!job) return;
    try {
      setJob(await featureRerender(job.id, index));
    } catch (e: any) {
      setError(e?.message || 'Hindi na-render muli ang eksena.');
    }
  };

  const assemble = async () => {
    if (!job) return;
    setBusy(true);
    setError('');
    try {
      setJob(await featureAssemble(job.id));
    } catch (e: any) {
      setError(e?.message || 'Hindi naidugtong ang pelikula.');
    } finally {
      setBusy(false);
    }
  };

  const running = job?.status === 'running';
  const totalScenes = job?.total ?? status?.scenes ?? 18;

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 p-4">
      <header className="rounded-panel border border-subtle bg-surface p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-primary text-primary-ink">
            <Clapperboard className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">Feature Film Factory</h1>
            <p className="mt-1 text-sm text-muted">
              Isang konsepto, {totalScenes} eksena, 90 minuto. Bawat 5-minutong eksena ay hiwalay na
              nire-render at dumadaan sa Staging Vault — kung may palpak, iyon lang ang ire-render muli,
              hindi ang buong pelikula. FFmpeg ang magdudugtong sa mga aprubadong eksena.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
          <span className="rounded-pill border border-subtle bg-raised px-2.5 py-1 text-muted">
            <Layers className="mr-1 inline h-3 w-3" />
            {totalScenes} eksena × 5 min = {status?.total_clock ?? '1:30:00'}
          </span>
          <span className={`rounded-pill border px-2.5 py-1 font-medium ${status?.ffmpeg ? 'border-growth-soft bg-growth-soft/15 text-growth' : 'border-subtle bg-raised text-muted'}`}>
            <Film className="mr-1 inline h-3 w-3" />
            {status?.ffmpeg ? 'FFmpeg: handa (‑c copy stitching)' : 'FFmpeg: hindi mahanap'}
          </span>
          <span className="rounded-pill border border-subtle bg-raised px-2.5 py-1 text-muted">
            <Play className="mr-1 inline h-3 w-3" />
            T3 video → local ComfyUI ({job?.scenes?.[0]?.route?.placement ?? 'local'})
          </span>
          <span
            className={`rounded-pill border px-2.5 py-1 font-medium ${
              status?.pilot?.preferred === 'kaggle'
                ? 'border-growth-soft bg-growth-soft/15 text-growth'
                : status?.pilot?.preferred === 'local-ollama'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                  : 'border-subtle bg-raised text-muted'
            }`}
            title={
              status?.pilot?.preferred === 'kaggle'
                ? status.pilot.detail
                : status?.pilot?.preferred === 'local-ollama'
                  ? `Fallback: ${status.pilot.local.detail}`
                  : `${status?.pilot?.detail ?? ''} ${status?.pilot?.local?.detail ?? ''}`.trim()
            }
          >
            <Sparkles className="mr-1 inline h-3 w-3" />
            {status?.pilot?.preferred === 'kaggle'
              ? 'Pilot: Kaggle (T3)'
              : status?.pilot?.preferred === 'local-ollama'
                ? `Pilot: local Ollama (T1)`
                : 'Pilot: wala'}
          </span>
        </div>
      </header>

      <section className="rounded-panel border border-subtle bg-surface p-5">
        <label className="text-xs font-medium text-muted" htmlFor="feature-brief">Ang konsepto</label>
        <textarea
          id="feature-brief"
          value={brief}
          onChange={e => setBrief(e.target.value)}
          rows={3}
          placeholder="Halimbawa: Isang mangingisda sa probinsya na may nakatagong lihim, SPG, Realistic."
          className="mt-1.5 w-full resize-none rounded-card border border-subtle bg-sunken px-3 py-2.5 text-sm text-ink placeholder-faint outline-none focus:border-primary"
        />

        <div className="mt-3 flex flex-wrap gap-2">
          {IDEAS.map(idea => (
            <button
              key={idea}
              type="button"
              onClick={() => setBrief(idea)}
              className="rounded-pill border border-subtle bg-raised px-3 py-1.5 text-left text-[11px] text-muted transition-colors hover:border-edge hover:text-ink"
            >
              {idea.length > 62 ? `${idea.slice(0, 62)}…` : idea}
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-4">
          <div>
            <label className="text-xs font-medium text-muted" htmlFor="feature-title">Pamagat (opsyonal)</label>
            <input
              id="feature-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="auto mula sa brief"
              className="mt-1.5 w-full rounded-card border border-subtle bg-sunken px-2.5 py-2 text-sm text-ink placeholder-faint outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted" htmlFor="feature-genre">Genre (opsyonal)</label>
            <input
              id="feature-genre"
              value={genre}
              onChange={e => setGenre(e.target.value)}
              placeholder="auto"
              className="mt-1.5 w-full rounded-card border border-subtle bg-sunken px-2.5 py-2 text-sm text-ink placeholder-faint outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted" htmlFor="feature-rating">Rating</label>
            <select
              id="feature-rating"
              value={rating}
              onChange={e => setRating(e.target.value)}
              className="mt-1.5 w-full rounded-card border border-subtle bg-sunken px-2.5 py-2 text-sm text-ink outline-none focus:border-primary"
            >
              <option value="">(auto)</option>
              {(status?.ratings ?? ['G', 'PG', 'SPG', 'R']).map(r => (
                <option key={r} value={r}>{status?.rating_labels?.[r] ?? r}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted" htmlFor="feature-format">Format</label>
            <select
              id="feature-format"
              value={format}
              onChange={e => setFormat(e.target.value)}
              className="mt-1.5 w-full rounded-card border border-subtle bg-sunken px-2.5 py-2 text-sm text-ink outline-none focus:border-primary"
            >
              <option value="">(auto)</option>
              {(status?.formats ?? ['Animated', 'Realistic']).map(f => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={makeConcept}
            disabled={busy || !brief.trim()}
            className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Gumawa ng konsepto
          </button>
          {job && (
            <>
              <button
                type="button"
                onClick={start}
                disabled={busy || running}
                className="inline-flex items-center gap-2 rounded-pill border border-growth-soft bg-growth-soft/15 px-4 py-2.5 text-sm font-medium text-growth disabled:opacity-40"
              >
                <Play className="h-4 w-4" /> START BATCH
              </button>
              <button
                type="button"
                onClick={fetchPilot}
                disabled={busy || running}
                title="Hingin ang script at character bible: Kaggle (T3) muna, local Ollama (T1) kung wala"
                className="inline-flex items-center gap-2 rounded-pill border border-subtle bg-raised px-4 py-2.5 text-sm font-medium text-ink disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Pilot script
              </button>
              <button
                type="button"
                onClick={pause}
                disabled={busy || !running}
                className="inline-flex items-center gap-2 rounded-pill border border-subtle bg-raised px-4 py-2.5 text-sm font-medium text-ink disabled:opacity-40"
              >
                <Pause className="h-4 w-4" /> PAUSE BATCH
              </button>
              <button
                type="button"
                onClick={assemble}
                disabled={busy || (job.approved < 2)}
                className="inline-flex items-center gap-2 rounded-pill border border-subtle bg-raised px-4 py-2.5 text-sm font-medium text-ink disabled:opacity-40"
                title={job.approved < 2 ? 'Kailangan ng 2 aprubadong eksena' : 'Idugtong ang mga aprubadong eksena'}
              >
                <Film className="h-4 w-4" /> Idugtong (‑c copy)
              </button>
            </>
          )}
        </div>

        {error && (
          <p className="mt-3 flex items-start gap-2 rounded-card border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
      </section>

      {job && (
        <section className="rounded-panel border border-subtle bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-ink">{job.concept.title}</h2>
              <p className="text-[11px] text-muted">
                {job.concept.genre} · {job.concept.rating} · {job.concept.format} · {job.concept.brief.slice(0, 70)}
              </p>
            </div>
            <span className="rounded-pill border border-subtle bg-raised px-2.5 py-1 text-[11px] text-muted">
              {job.status}
            </span>
          </div>

          {job.script && (
            <details className="mt-4 rounded-card border border-subtle bg-sunken p-3">
              <summary className="cursor-pointer text-xs font-medium text-ink">
                Script{pilotSource ? ` mula sa ${pilotSource}` : ''} ({job.script.length.toLocaleString()} chars
                {job.bible ? ', may character bible' : ''})
              </summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] text-muted">
                {job.script}
              </pre>
              {job.bible && (
                <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap border-t border-subtle pt-2 text-[11px] text-dim">
                  {job.bible}
                </pre>
              )}
            </details>
          )}

          {/* The whole film. */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Buong pelikula · {job.filmClock} / {job.totalClock}</span>
              <span className="text-ink">{job.percent}%</span>
            </div>
            <div className="mt-2 h-3 w-full overflow-hidden rounded-pill bg-raised">
              <div
                className={`h-full rounded-pill transition-all ${job.failed && !job.rendered ? 'bg-red-500' : job.status === 'done' ? 'bg-growth' : 'bg-primary'}`}
                style={{ width: `${job.percent}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
              <span>Tapos: {job.rendered}/{job.total}</span>
              <span>Aprubado: {job.approved}</span>
              <span>Bigo: {job.failed}</span>
              {job.currentScene ? <span>Ginagawa: eksena {job.currentScene}</span> : null}
            </div>
          </div>

          {/* The 18 scenes. */}
          <div className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted">Bawat eksena (5 minuto)</p>
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-dim">
                {STAGES.map((s, si) => (
                  <span key={s.key} className="inline-flex items-center gap-1">
                    <span
                      className={`inline-block h-1.5 w-4 rounded-pill ${
                        si === 0 ? 'bg-growth' : si === 1 ? 'bg-primary' : 'bg-sunken'
                      }`}
                    />
                    {s.label}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {job.scenes.map(scene => (
                <div key={scene.index} className="rounded-card border border-subtle bg-raised p-2.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-medium text-ink">E{scene.index}</span>
                    <span className="text-dim">A{scene.act} · {scene.route.tier}</span>
                  </div>
                  <div className="mt-1.5 flex gap-0.5">
                    {STAGES.map((s, si) => {
                      const reached = stageIndex(scene.stage) >= si && scene.status !== 'pending';
                      const done = stageIndex(scene.stage) > si;
                      const failed = scene.status === 'failed' || scene.status === 'rejected';
                      const cls = failed
                        ? 'bg-red-500'
                        : done
                          ? 'bg-growth'
                          : reached
                            ? 'bg-primary animate-pulse'
                            : 'bg-sunken';
                      return (
                        <div
                          key={s.key}
                          className={`h-1.5 flex-1 overflow-hidden rounded-pill ${cls}`}
                          title={`${s.label}${reached ? ' ✓' : ''}`}
                        />
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[10px] text-muted">
                    {scene.status === 'pending'
                      ? SCENE_LABEL.pending
                      : scene.status === 'failed' || scene.status === 'rejected'
                        ? SCENE_LABEL[scene.status]
                        : STAGES[stageIndex(scene.stage)].label}
                  </p>
                  {scene.error && <p className="mt-1 text-[10px] text-red-300">{scene.error.slice(0, 60)}</p>}
                  {scene.shots && scene.shots.length > 0 && (
                    <p
                      className="mt-1 text-[10px] text-dim"
                      title={scene.shots.map(s => `${s.framing} ${s.seconds}s`).join(' → ')}
                    >
                      {scene.shots.length} shot{scene.shots.length > 1 ? 's' : ''} ·{' '}
                      {scene.shots.map(s => s.framing[0].toUpperCase()).join('→')}
                    </p>
                  )}
                  {scene.renderUrl && (scene.status === 'rendered' || scene.status === 'approved') && (
                    <a
                      href={scene.renderUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                    >
                      <Play className="h-3 w-3" /> Play
                    </a>
                  )}
                  {(scene.status === 'failed' || scene.status === 'rejected') && (
                    <button
                      type="button"
                      onClick={() => rerender(scene.index)}
                      className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                    >
                      <RefreshCw className="h-3 w-3" /> Render muli
                    </button>
                  )}
                  {scene.status === 'approved' && scene.assetName && (
                    <a
                      href={assetDownloadUrl(scene.assetName)}
                      className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-growth hover:underline"
                    >
                      <Download className="h-3 w-3" /> Scene
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>

          {job.film && (
            <div className="mt-5 rounded-card border border-growth-soft bg-growth-soft/10 p-4">
              <p className="text-sm font-medium text-growth">
                Naidugtong na ang buong pelikula ({job.filmClock})
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <a
                  href={assetDownloadUrl(job.film.assetName)}
                  className="inline-flex items-center gap-2 rounded-pill border border-growth-soft bg-growth-soft/15 px-4 py-2 text-sm font-medium text-growth"
                >
                  <Download className="h-4 w-4" /> I-download ang MP4 ({bytes(job.film.bytes)})
                </a>
                <video
                  className="w-full rounded-card border border-subtle bg-black"
                  controls
                  preload="metadata"
                  src={assetDownloadUrl(job.film.assetName)}
                />
              </div>
            </div>
          )}

          {job.error && (
            <p className="mt-3 text-xs text-red-300">{job.error}</p>
          )}
        </section>
      )}
    </div>
  );
}
