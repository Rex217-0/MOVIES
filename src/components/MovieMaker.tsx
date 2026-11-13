import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Clapperboard, Download, Film, Loader2, Mic, Play, RefreshCw, Sparkles, TriangleAlert,
} from 'lucide-react';
import {
  assetDownloadUrl, movieStart, movieStatus, movieWait,
  type MovieJobView, type MovieStatus,
} from '../api';
import { MOOD_LABELS, type Mood } from '../movieMeta';

const IDEAS = [
  'Isang mangingisda sa probinsya na may nakatagong lihim, 3 minuto, mabigat.',
  'Horror sa masukal na gubat: may sumusunod sa mga bisita, 4 minuto, nakakakaba.',
  'Romance sa palengke ng Maynila, 2 minuto, magaan at masaya.',
  'Sci-fi sa isang kolonya sa Mars na nauubusan ng tubig, 5 minuto, tense.',
];

function bytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function MovieMaker() {
  const [status, setStatus] = useState<MovieStatus | null>(null);
  const [brief, setBrief] = useState('');
  const [minutes, setMinutes] = useState(3);
  const [mood, setMood] = useState<Mood | ''>('');
  const [voice, setVoice] = useState('Kore');
  const [job, setJob] = useState<MovieJobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);

  const load = useCallback(() => {
    movieStatus().then(s => { if (alive.current) setStatus(s); }).catch(() => {});
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const id = setInterval(load, 15000);
    return () => { alive.current = false; clearInterval(id); };
  }, [load]);

  const makeMovie = async () => {
    const text = brief.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    setJob(null);
    try {
      const { job: id } = await movieStart({
        brief: text,
        minutes,
        mood: mood || undefined,
        voice: status?.narration ? voice : undefined,
      });
      const final = await movieWait(id, j => { if (alive.current) setJob({ ...j }); });
      if (alive.current) setJob({ ...final });
    } catch (e: any) {
      if (alive.current) setError(e?.message || 'Hindi nagawa ang pelikula.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const done = job?.status === 'done' && job.asset;
  const failed = job?.status === 'error';

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 p-4">
      <header className="rounded-panel border border-subtle bg-surface p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-primary text-primary-ink">
            <Clapperboard className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">Movie Maker</h1>
            <p className="mt-1 text-sm text-muted">
              Isang pangungusap lang ang ibigay. Ang Movie Robo ang magsusulat ng screenplay,
              maglalagay ng Tagalog na boses, at magre-render ng totoong MP4 na ma-download mo.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
          <span className={`rounded-pill border px-2.5 py-1 font-medium ${status?.narration_tagalog ? 'border-growth-soft bg-growth-soft/15 text-growth' : 'border-subtle bg-raised text-muted'}`}>
            <Mic className="mr-1 inline h-3 w-3" />
            {status?.narration_tagalog ? 'Tagalog na boses (libre, offline)' : 'Tagalog na boses: hindi aktibo'}
          </span>
          <span className={`rounded-pill border px-2.5 py-1 font-medium ${status?.narration_fish ? 'border-growth-soft bg-growth-soft/15 text-growth' : 'border-subtle bg-raised text-muted'}`}>
            <Mic className="mr-1 inline h-3 w-3" />
            {status?.narration_fish ? 'Fish Audio: aktibo' : 'Fish Audio: kailangan ng key'}
          </span>
          <span className={`rounded-pill border px-2.5 py-1 font-medium ${status?.narration_cloud ? 'border-primary-soft bg-primary-soft/20 text-primary' : 'border-subtle bg-raised text-muted'}`}>
            <Mic className="mr-1 inline h-3 w-3" />
            {status?.narration_cloud ? `Cloud na boses: ${status.tts_model}` : 'Cloud na boses: hindi aktibo'}
          </span>
          <span className="rounded-pill border border-subtle bg-raised px-2.5 py-1 text-muted">
            <Film className="mr-1 inline h-3 w-3" />
            Render: ffmpeg (local, libre)
          </span>
        </div>
        <p className="mt-2 text-[11px] text-dim">
          Ang Tagalog na boses ay libre at tumatakbo sa CPU — hindi ito nauubos. Kung may Fish Audio key, iyon ang
          mauuna. Susunod ang cloud na boses at Piper. Kapag wala ang lahat, nakasulat pa rin ang kuwento sa video
          (captions) — hindi tumitigil ang pelikula.
        </p>
      </header>

      <section className="rounded-panel border border-subtle bg-surface p-5">
        <label className="text-xs font-medium text-muted" htmlFor="brief">Ang ideya mo</label>
        <textarea
          id="brief"
          value={brief}
          onChange={e => setBrief(e.target.value)}
          rows={3}
          placeholder="Halimbawa: Isang mangingisda sa probinsya na may nakatagong lihim, 3 minuto, mabigat."
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

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-xs font-medium text-muted" htmlFor="minutes">
              Haba: <span className="text-ink">{minutes} min</span>
            </label>
            <input
              id="minutes"
              type="range"
              min={status?.min_minutes ?? 1}
              max={status?.max_minutes ?? 5}
              step={1}
              value={minutes}
              onChange={e => setMinutes(Number(e.target.value))}
              className="mt-2 w-full accent-[#ffda2a]"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted" htmlFor="mood">Mood</label>
            <select
              id="mood"
              value={mood}
              onChange={e => setMood(e.target.value as Mood | '')}
              className="mt-1.5 w-full rounded-card border border-subtle bg-sunken px-2.5 py-2 text-sm text-ink outline-none focus:border-primary"
            >
              <option value="">(auto — bahala si Movie Robo)</option>
              {(status?.moods ?? Object.keys(MOOD_LABELS)).map(m => (
                <option key={m} value={m}>{MOOD_LABELS[m as Mood] ?? m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted" htmlFor="voice">Boses (cloud; ang Tagalog ay awtomatiko)</label>
            <select
              id="voice"
              value={voice}
              disabled={!status?.narration_cloud}
              onChange={e => setVoice(e.target.value)}
              className="mt-1.5 w-full rounded-card border border-subtle bg-sunken px-2.5 py-2 text-sm text-ink outline-none focus:border-primary disabled:opacity-50"
            >
              {(status?.voices ?? [voice]).map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={makeMovie}
            disabled={busy || !brief.trim()}
            className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {busy ? 'Ginagawa ang pelikula…' : 'Gawa ng pelikula'}
          </button>
          {done && (
            <a
              href={assetDownloadUrl(job!.asset!.name)}
              className="inline-flex items-center gap-2 rounded-pill border border-growth-soft bg-growth-soft/15 px-4 py-2.5 text-sm font-medium text-growth"
            >
              <Download className="h-4 w-4" /> I-download ang MP4
            </a>
          )}
          {!busy && job && (
            <button
              type="button"
              onClick={() => { setJob(null); setError(''); }}
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5" /> I-reset
            </button>
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
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink">
              {job.title || job.brief.slice(0, 60)}
            </h2>
            <span className="text-xs text-muted">{job.percent}%</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-pill bg-raised">
            <div
              className={`h-full rounded-pill transition-all ${failed ? 'bg-red-500' : done ? 'bg-growth' : 'bg-primary'}`}
              style={{ width: `${job.percent}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            {failed ? job.error : `${job.stage}${job.detail ? ` · ${job.detail}` : ''}`}
          </p>

          {done && (
            <>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-card border border-subtle bg-raised p-3">
                  <p className="text-[10px] uppercase tracking-wide text-dim">Haba</p>
                  <p className="text-sm font-semibold text-ink">{clock(job.seconds ?? 0)}</p>
                </div>
                <div className="rounded-card border border-subtle bg-raised p-3">
                  <p className="text-[10px] uppercase tracking-wide text-dim">Eksena</p>
                  <p className="text-sm font-semibold text-ink">{job.scenes ?? 0}</p>
                </div>
                <div className="rounded-card border border-subtle bg-raised p-3">
                  <p className="text-[10px] uppercase tracking-wide text-dim">Laki</p>
                  <p className="text-sm font-semibold text-ink">{job.asset ? bytes(job.asset.bytes) : '—'}</p>
                </div>
              </div>
              {job.note && <p className="mt-3 text-xs text-muted">{job.note}</p>}
              <video
                className="mt-4 w-full rounded-card border border-subtle bg-black"
                controls
                preload="metadata"
                src={assetDownloadUrl(job.asset!.name)}
              />
            </>
          )}
        </section>
      )}

      {(status?.jobs?.length ?? 0) > 0 && (
        <section className="rounded-panel border border-subtle bg-surface p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Play className="h-3.5 w-3.5" /> Mga nagawang pelikula
          </h2>
          <ul className="mt-3 divide-y divide-subtle">
            {status!.jobs.map(j => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{j.title || j.brief}</p>
                  <p className="text-[11px] text-muted">
                    {new Date(j.startedAt).toLocaleString()} · {j.minutes} min
                    {j.seconds ? ` · ${clock(j.seconds)}` : ''}
                    {j.status === 'error' ? ` · ${j.error}` : ''}
                  </p>
                </div>
                {j.status === 'done' && j.asset ? (
                  <a
                    href={assetDownloadUrl(j.asset.name)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-subtle bg-raised px-3 py-1.5 text-[11px] text-ink hover:border-edge"
                  >
                    <Download className="h-3.5 w-3.5" /> {bytes(j.asset.bytes)}
                  </a>
                ) : (
                  <span className="shrink-0 text-[11px] text-muted">
                    {j.status === 'running' ? `${j.percent}%` : 'bigo'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
