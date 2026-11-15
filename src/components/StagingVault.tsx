/**
 * Staging Vault: review the renders the app actually produced.
 *
 * Unlike the mock CineStream vault, this reads the real asset store
 * (`/api/direk/assets`) and writes the decision back with
 * `POST /api/direk/assets/review`, so "Published" means a human approved it.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch, assetDownloadUrl, direkReviewAsset, type AssetItem, type ReviewStatus } from '../api';
import { PlayCircle, CheckCircle, XCircle, RefreshCw, Film, ShieldCheck, Clock, Image as ImageIcon, Music } from 'lucide-react';

const POLL_MS = 10000;

function kindIcon(kind: AssetItem['kind']) {
  if (kind === 'video') return <PlayCircle size={36} className="opacity-40" />;
  if (kind === 'audio') return <Music size={36} className="opacity-40" />;
  return <ImageIcon size={36} className="opacity-40" />;
}

const STATUS_STYLE: Record<ReviewStatus, string> = {
  pending: 'bg-primary-soft text-primary border-primary',
  approved: 'bg-growth-soft text-growth border-growth-soft',
  rejected: 'bg-red-500/10 text-red-300 border-red-500/40',
};

export const StagingVault: React.FC<{ onJumpToVideoGen?: () => void }> = ({ onJumpToVideoGen }) => {
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/direk/assets');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAssets(data.assets ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Hindi ma-load ang assets.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const statusOf = (a: AssetItem): ReviewStatus => a.reviewStatus ?? 'pending';
  const counts = useMemo(() => {
    const c: Record<ReviewStatus, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const a of assets) c[statusOf(a)]++;
    return c;
  }, [assets]);
  const filtered = assets.filter(a => statusOf(a) === tab);

  const review = async (id: string, action: 'approve' | 'reject') => {
    setBusy(id);
    try {
      const updated = await direkReviewAsset(id, action);
      setAssets(prev => prev.map(a => (a.id === id ? updated : a)));
    } catch (e: any) {
      setError(e?.message || 'Nabigo ang review.');
    } finally {
      setBusy(null);
    }
  };

  const tabs: { id: typeof tab; label: string; icon: React.ReactNode }[] = [
    { id: 'pending', label: 'STAGING', icon: <Clock size={15} /> },
    { id: 'approved', label: 'PUBLISHED', icon: <CheckCircle size={15} /> },
    { id: 'rejected', label: 'REJECTED', icon: <XCircle size={15} /> },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-card border border-subtle bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-subtle bg-page-soft p-3">
        <div className="flex gap-4">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 border-b-2 pb-1 text-sm font-bold tracking-widest transition-colors ${
                tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {t.icon} {t.label}
              {counts[t.id] > 0 && (
                <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${STATUS_STYLE[t.id]}`}>
                  {counts[t.id]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {onJumpToVideoGen && (
            <button
              onClick={onJumpToVideoGen}
              className="flex items-center gap-1.5 rounded-card border border-edge bg-raised px-2.5 py-1 text-xs text-muted transition-colors hover:text-ink"
            >
              <Film size={12} /> RENDER NEW
            </button>
          )}
          <button
            onClick={load}
            title="Refresh assets"
            aria-label="Refresh assets"
            className="rounded-card p-1.5 text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{error}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {filtered.length === 0 && !isLoading ? (
          <div className="flex h-full flex-col items-center justify-center space-y-2 p-8 text-center text-xs text-muted">
            <ShieldCheck size={36} className="mb-1 opacity-40" />
            <p className="text-sm font-bold text-muted">Walang laman ang {tabs.find(t => t.id === tab)?.label}.</p>
            <p className="max-w-sm text-[11px]">
              {tab === 'pending'
                ? 'Lalabas dito ang bawat render. I-approve para ma-publish, o i-reject para itapon.'
                : `Wala pang naka-${tab} na render.`}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map(asset => (
              <div key={asset.id} className="overflow-hidden rounded-card border border-subtle bg-page-soft">
                <div className="relative flex aspect-video items-center justify-center bg-black">
                  {asset.kind === 'video' ? (
                    <video src={assetDownloadUrl(asset.name)} controls className="h-full w-full object-cover" />
                  ) : asset.kind === 'image' ? (
                    <img src={assetDownloadUrl(asset.name)} alt={asset.title} className="h-full w-full object-contain" />
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-muted">
                      {kindIcon(asset.kind)}
                      <audio src={assetDownloadUrl(asset.name)} controls className="w-56" />
                    </div>
                  )}
                  <div className="absolute right-2 top-2 rounded-card border border-edge bg-black/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-ink backdrop-blur-sm">
                    {asset.kind} · {asset.ext}
                  </div>
                </div>
                <div className="p-3">
                  <h3 className="truncate text-xs font-bold text-ink">{asset.title}</h3>
                  <p className="mt-1 text-[10px] text-muted">
                    {new Date(asset.createdAt).toLocaleString()} · {(asset.bytes / 1024).toFixed(0)} KB · {asset.source}
                  </p>
                  <div className="mt-3 flex gap-2">
                    {tab === 'pending' ? (
                      <>
                        <button
                          disabled={busy === asset.id}
                          onClick={() => review(asset.id, 'approve')}
                          className="flex flex-1 items-center justify-center gap-1 rounded-card border border-growth-soft bg-growth-soft py-1.5 text-[10px] font-bold text-growth transition-all hover:brightness-110 disabled:opacity-50"
                        >
                          <CheckCircle size={12} /> APPROVE &amp; PUBLISH
                        </button>
                        <button
                          disabled={busy === asset.id}
                          onClick={() => review(asset.id, 'reject')}
                          className="flex flex-1 items-center justify-center gap-1 rounded-card border border-red-500/40 bg-red-500/10 py-1.5 text-[10px] font-bold text-red-300 transition-colors disabled:opacity-50"
                        >
                          <XCircle size={12} /> REJECT
                        </button>
                      </>
                    ) : (
                      <a
                        href={assetDownloadUrl(asset.name)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex w-full items-center justify-center gap-1 rounded-card bg-primary py-1.5 text-[10px] font-bold text-primary-ink transition-colors hover:bg-primary-hover"
                      >
                        <Film size={12} /> BUKSAN
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default StagingVault;
