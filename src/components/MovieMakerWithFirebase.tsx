import React, { useEffect, useRef, useState } from 'react';
import { Cloud, Loader2, TriangleAlert } from 'lucide-react';
import { MovieMaker } from './MovieMaker';
import { movieStatus, type MovieJobView } from '../api';
import { listMovieHistory, saveMovieHistory, ensureAnonymousSession, type SavedMovie } from '../firebaseClient';

function historyRecord(job: MovieJobView): SavedMovie {
  return {
    id: job.id,
    title: job.title || job.brief.slice(0, 120),
    brief: job.brief,
    status: job.status,
    minutes: job.minutes,
    scenes: job.scenes ?? null,
    seconds: job.seconds ?? null,
    startedAt: new Date(job.startedAt).toISOString(),
    endedAt: job.endedAt ? new Date(job.endedAt).toISOString() : null,
    error: job.error ?? null,
    asset: job.asset ? { name: job.asset.name, bytes: job.asset.bytes, kind: job.asset.kind, title: job.asset.title } : null,
  };
}

/** Movie Maker plus per-user Firestore history, synced through Firebase Auth REST. */
export function MovieMakerWithFirebase() {
  const [history, setHistory] = useState<SavedMovie[]>([]);
  const [message, setMessage] = useState('Inihahanda ang Firebase movie history…');
  const [error, setError] = useState('');
  const seen = useRef(new Map<string, string>());

  useEffect(() => {
    let alive = true;
    let busy = false;

    const sync = async () => {
      if (busy) return;
      busy = true;
      try {
        await ensureAnonymousSession();
        const [saved, status] = await Promise.all([listMovieHistory(), movieStatus()]);
        if (!alive) return;

        for (const job of status.jobs) {
          const signature = `${job.status}:${job.endedAt ?? ''}`;
          if (seen.current.get(job.id) === signature) continue;
          await saveMovieHistory(historyRecord(job));
          seen.current.set(job.id, signature);
        }

        const refreshed = await listMovieHistory();
        if (!alive) return;
        setHistory(refreshed.length ? refreshed : saved);
        setMessage('Naka-sync ang history sa Firebase Firestore.');
        setError('');
      } catch (reason) {
        if (!alive) return;
        setError(reason instanceof Error ? reason.message : 'Hindi ma-access ang Firebase movie history.');
        setMessage('Hindi pa naka-sync ang Firebase history.');
      } finally {
        busy = false;
      }
    };

    void sync();
    const timer = window.setInterval(() => void sync(), 10000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4">
      <MovieMaker />
      <section className="rounded-panel border border-subtle bg-surface p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Cloud className="h-4 w-4 text-primary" /> Firebase movie history
        </h2>
        <p className="mt-1 text-xs text-muted">{message}</p>
        {error && (
          <p className="mt-3 flex items-start gap-2 rounded-card border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
        {!error && history.length === 0 && (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />Wala pang saved movie jobs.</p>
        )}
        {history.length > 0 && (
          <ul className="mt-3 divide-y divide-subtle">
            {history.map(movie => (
              <li key={movie.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{movie.title}</p>
                  <p className="text-[11px] text-muted">{new Date(movie.startedAt).toLocaleString()} · {movie.minutes} min</p>
                </div>
                <span className={`rounded-pill px-2.5 py-1 text-[10px] font-semibold ${movie.status === 'done' ? 'bg-growth-soft/15 text-growth' : movie.status === 'error' ? 'bg-red-500/10 text-red-300' : 'bg-primary-soft/20 text-primary'}`}>
                  {movie.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
