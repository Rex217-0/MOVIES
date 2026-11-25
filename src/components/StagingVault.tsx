/**
 * Staging Vault: review the renders the app actually produced.
 *
 * Unlike the mock CineStream vault, this reads the real asset store
 * (`/api/direk/assets`) and writes the decision back with
 * `POST /api/direk/assets/review`. Every card can show the facts the engine
 * recorded — seed, resolution, checksum, and the Section 7 declaration — so a
 * human approves the render that was actually made, not the one they assume.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  apiFetch,
  assetDownloadUrl,
  direkReviewAsset,
  type AssetItem,
  type VaultDisposition,
} from '../api';
import {
  PlayCircle, CheckCircle, XCircle, RefreshCw, Film, ShieldCheck, Clock,
  Image as ImageIcon, Music, Info, ChevronDown, History, Sparkles,
} from 'lucide-react';

const POLL_MS = 10000;

type Tab = 'staging' | 'approved' | 'rejected' | 'superseded';

/** Which dispositions belong under which tab. Exactly one home each. */
const TAB_DISPOSITIONS: Record<Tab, VaultDisposition[]> = {
  staging: ['PENDING_REVIEW', 'APPROVED_PREVIEW_ONLY', 'REFINE'],
  approved: ['APPROVED_MASTER'],
  rejected: ['REJECTED_TECHNICAL', 'REJECTED_CREATIVE'],
  superseded: ['SUPERSEDED'],
};

const DISPOSITION_LABEL: Record<VaultDisposition, string> = {
  PENDING_REVIEW: 'STAGING',
  APPROVED_MASTER: 'APPROVED · MASTER',
  APPROVED_PREVIEW_ONLY: 'APPROVED · PREVIEW ONLY',
  REFINE: 'REFINE',
  REJECTED_TECHNICAL: 'REJECTED · TECHNICAL',
  REJECTED_CREATIVE: 'REJECTED · CREATIVE',
  SUPERSEDED: 'SUPERSEDED',
};

const DISPOSITION_STYLE: Record<VaultDisposition, string> = {
  PENDING_REVIEW: 'bg-primary-soft text-primary border-primary',
  APPROVED_MASTER: 'bg-growth-soft text-growth border-growth-soft',
  APPROVED_PREVIEW_ONLY: 'bg-amber-500/10 text-amber-300 border-amber-500/40',
  REFINE: 'bg-amber-500/10 text-amber-300 border-amber-500/40',
  REJECTED_TECHNICAL: 'bg-red-500/10 text-red-300 border-red-500/40',
  REJECTED_CREATIVE: 'bg-red-500/10 text-red-300 border-red-500/40',
  SUPERSEDED: 'bg-white/5 text-muted border-edge',
};

function kindIcon(kind: AssetItem['kind']) {
  if (kind === 'video') return <PlayCircle size={36} className="opacity-40" />;
  if (kind === 'audio') return <Music size={36} className="opacity-40" />;
  return <ImageIcon size={36} className="opacity-40" />;
}

/** A sidecar written before dispositions existed has none; read it as pending. */
function dispositionOf(a: AssetItem): VaultDisposition {
  if (a.disposition) return a.disposition;
  if (a.reviewStatus === 'approved') return 'APPROVED_MASTER';
  if (a.reviewStatus === 'rejected') return 'REJECTED_CREATIVE';
  return 'PENDING_REVIEW';
}

/** One fact row, or nothing at all when the fact was never recorded. */
const Fact: React.FC<{ label: string; value?: React.ReactNode; mono?: boolean }> = ({
  label, value, mono,
}) => {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <span className={`truncate text-right text-[10px] text-ink ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
};

/** The provenance panel: what the engine reported, shown without embellishment. */
const ProvenancePanel: React.FC<{ asset: AssetItem }> = ({ asset }) => {
  const seedText =
    asset.seed !== undefined
      ? String(asset.seed)
      : asset.seeds?.length
        ? `${asset.seeds.length} shot · ${asset.seeds.join(', ')}`
        : undefined;
  const originality = asset.originality;
  const frames = asset.framesDuration ?? asset.provenance?.framesDuration;

  return (
    <div className="mt-2 space-y-1 rounded-card border border-subtle bg-black/20 p-2">
      <Fact label="Backend" value={asset.backend ?? asset.provenance?.backend} />
      <Fact label="Media class" value={asset.mediaClass ?? asset.provenance?.mediaClass} />
      <Fact label="Tier" value={asset.qualityTier ?? asset.provenance?.qualityTier} />
      <Fact label="Model / workflow" value={asset.modelOrWorkflowVersion ?? asset.provenance?.modelOrWorkflowVersion} />
      <Fact label="Seed" value={seedText} mono />
      <Fact label="Resolution" value={asset.resolution ?? asset.provenance?.resolution} mono />
      <Fact
        label="Frames"
        value={
          frames
            ? [
                frames.frames !== undefined ? `${frames.frames} frames` : null,
                frames.seconds !== undefined ? `${frames.seconds}s` : null,
                frames.fps !== undefined ? `${frames.fps} fps` : null,
              ].filter(Boolean).join(' · ')
            : undefined
        }
      />
      <Fact label="Audio" value={asset.audioState ?? asset.provenance?.audioState} />
      <Fact label="Checksum" value={asset.checksum ? `${asset.checksum.slice(0, 16)}…` : undefined} mono />
      <Fact label="Prompt hash" value={asset.promptHash ? `${asset.promptHash.slice(0, 16)}…` : undefined} mono />
      {asset.parentAssetId && <Fact label="Re-rendered from" value={asset.parentAssetId} mono />}
      {asset.replacementAssetId && <Fact label="Replaced by" value={asset.replacementAssetId} mono />}
      {asset.reviewer && <Fact label="Reviewed by" value={asset.reviewer} />}
      {asset.reviewedAt && (
        <Fact label="Reviewed at" value={new Date(asset.reviewedAt).toLocaleString()} />
      )}
      {asset.reason && <Fact label="Reason" value={asset.reason} />}

      {originality ? (
        <div className="mt-1 border-t border-subtle pt-1">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted">
            <Sparkles size={10} /> SECTION 7
            {originality.humanReviewed && (
              <span className="ml-auto rounded-full border border-growth-soft bg-growth-soft px-1.5 text-[9px] text-growth">
                REVIEWED
              </span>
            )}
          </div>
          <p className="text-[10px] leading-relaxed text-muted">{originality.declaration}</p>
          <Fact label="Grounding" value={originality.groundingUsed ? 'ginamit' : 'wala'} />
          <Fact label="Genre" value={originality.groundingGenre} />
          <Fact label="References" value={originality.referenceCount || undefined} />
        </div>
      ) : (
        <p className="mt-1 border-t border-subtle pt-1 text-[10px] italic text-muted">
          Walang naka-record na Section 7 declaration para sa asset na ito.
        </p>
      )}
    </div>
  );
};

export const StagingVault: React.FC<{ onJumpToVideoGen?: () => void }> = ({ onJumpToVideoGen }) => {
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('staging');
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = async () => {
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

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { staging: 0, approved: 0, rejected: 0, superseded: 0 };
    for (const a of assets) {
      const d = dispositionOf(a);
      for (const [id, list] of Object.entries(TAB_DISPOSITIONS) as [Tab, VaultDisposition[]][]) {
        if (list.includes(d)) { c[id]++; break; }
      }
    }
    return c;
  }, [assets]);

  const filtered = assets.filter(a => TAB_DISPOSITIONS[tab].includes(dispositionOf(a)));

  const review = async (
    id: string,
    disposition: VaultDisposition,
    opts: { reason?: string } = {},
  ) => {
    setBusy(id);
    try {
      const updated = await direkReviewAsset(id, disposition, opts);
      setAssets(prev => prev.map(a => (a.id === id ? updated : a)));
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Nabigo ang review.');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Ask for a reason on every rejection and on every refine. The difference
   * between "basag ang audio" and "hindi ito ang gusto kong tono" is the whole
   * reason technical and creative are separate dispositions.
   */
  const reviewWithReason = (id: string, disposition: VaultDisposition, promptText: string) => {
    const reason = window.prompt(promptText, '');
    if (reason === null) return;
    review(id, disposition, { reason: reason.trim() || undefined });
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'staging', label: 'STAGING', icon: <Clock size={15} /> },
    { id: 'approved', label: 'PUBLISHED', icon: <CheckCircle size={15} /> },
    { id: 'rejected', label: 'REJECTED', icon: <XCircle size={15} /> },
    { id: 'superseded', label: 'SUPERSEDED', icon: <History size={15} /> },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-card border border-subtle bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-subtle bg-page-soft p-3">
        <div className="flex flex-wrap gap-4">
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
                <span className="rounded-full border border-edge px-1.5 py-0.5 text-[10px] font-bold text-muted">
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
              {tab === 'staging'
                ? 'Lalabas dito ang bawat render. APPROVE MASTER para isama sa pelikula, PREVIEW ONLY para panoorin lang, o REFINE para ipaulit.'
                : tab === 'approved'
                  ? 'Ang mga naka-APPROVED MASTER lang ang naisasama sa pelikula.'
                  : tab === 'rejected'
                    ? 'Nandito ang mga tinanggihan, teknikal man o creative.'
                    : 'Ang mga lumang render na napalitan ng re-render. Hindi ito binubura.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map(asset => {
              const d = dispositionOf(asset);
              const open = expanded[asset.id] ?? false;
              return (
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
                    <div className={`absolute left-2 top-2 rounded-card border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider backdrop-blur-sm ${DISPOSITION_STYLE[d]}`}>
                      {DISPOSITION_LABEL[d]}
                    </div>
                  </div>

                  <div className="p-3">
                    <h3 className="truncate text-xs font-bold text-ink">{asset.title}</h3>
                    <p className="mt-1 text-[10px] text-muted">
                      {new Date(asset.createdAt).toLocaleString()} · {(asset.bytes / 1024).toFixed(0)} KB · {asset.source}
                    </p>

                    <button
                      onClick={() => setExpanded(prev => ({ ...prev, [asset.id]: !open }))}
                      className="mt-2 flex w-full items-center justify-center gap-1 rounded-card border border-edge bg-raised py-1 text-[10px] font-bold text-muted transition-colors hover:text-ink"
                    >
                      <Info size={11} /> PROVENANCE
                      <ChevronDown size={11} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
                    </button>
                    {open && <ProvenancePanel asset={asset} />}

                    {tab === 'staging' && (
                      <div className="mt-3 space-y-2">
                        <div className="flex gap-2">
                          <button
                            disabled={busy === asset.id}
                            onClick={() => review(asset.id, 'APPROVED_MASTER')}
                            className="flex flex-1 items-center justify-center gap-1 rounded-card border border-growth-soft bg-growth-soft py-1.5 text-[10px] font-bold text-growth transition-all hover:brightness-110 disabled:opacity-50"
                            title="Isasama sa pelikula"
                          >
                            <CheckCircle size={12} /> APPROVE MASTER
                          </button>
                          <button
                            disabled={busy === asset.id}
                            onClick={() => review(asset.id, 'APPROVED_PREVIEW_ONLY')}
                            className="flex flex-1 items-center justify-center gap-1 rounded-card border border-amber-500/40 bg-amber-500/10 py-1.5 text-[10px] font-bold text-amber-300 transition-colors disabled:opacity-50"
                            title="Pwedeng panoorin, hindi isasama sa pelikula"
                          >
                            <PlayCircle size={12} /> PREVIEW ONLY
                          </button>
                        </div>
                        <button
                          disabled={busy === asset.id}
                          onClick={() =>
                            reviewWithReason(asset.id, 'REFINE', 'Ano ang ipapaayos? (o iwanang blangko)')
                          }
                          className="flex w-full items-center justify-center gap-1 rounded-card border border-amber-500/40 bg-amber-500/10 py-1.5 text-[10px] font-bold text-amber-300 transition-colors disabled:opacity-50"
                          title="Ipa-render muli"
                        >
                          <RefreshCw size={12} /> REFINE
                        </button>
                        <div className="flex gap-2">
                          <button
                            disabled={busy === asset.id}
                            onClick={() =>
                              reviewWithReason(asset.id, 'REJECTED_TECHNICAL', 'Anong teknikal na sira? (basag ang audio, glitch, atbp.)')
                            }
                            className="flex flex-1 items-center justify-center gap-1 rounded-card border border-red-500/40 bg-red-500/10 py-1.5 text-[10px] font-bold text-red-300 transition-colors disabled:opacity-50"
                            title="May sira sa file"
                          >
                            <XCircle size={12} /> TECH
                          </button>
                          <button
                            disabled={busy === asset.id}
                            onClick={() =>
                              reviewWithReason(asset.id, 'REJECTED_CREATIVE', 'Bakit hindi tama sa creative? (tono, casting, atbp.)')
                            }
                            className="flex flex-1 items-center justify-center gap-1 rounded-card border border-red-500/40 bg-red-500/10 py-1.5 text-[10px] font-bold text-red-300 transition-colors disabled:opacity-50"
                            title="Tama ang file, mali ang gusto"
                          >
                            <XCircle size={12} /> CREATIVE
                          </button>
                        </div>
                      </div>
                    )}

                    {tab !== 'staging' && (
                      <div className="mt-3 space-y-2">
                        <a
                          href={assetDownloadUrl(asset.name)}
                          target="_blank"
                          rel="noreferrer"
                          className="flex w-full items-center justify-center gap-1 rounded-card bg-primary py-1.5 text-[10px] font-bold text-primary-ink transition-colors hover:bg-primary-hover"
                        >
                          <Film size={12} /> BUKSAN
                        </a>
                        {d !== 'SUPERSEDED' && (
                          <button
                            disabled={busy === asset.id}
                            onClick={() => review(asset.id, 'PENDING_REVIEW')}
                            className="flex w-full items-center justify-center gap-1 rounded-card border border-edge bg-raised py-1.5 text-[10px] font-bold text-muted transition-colors hover:text-ink disabled:opacity-50"
                          >
                            <Clock size={12} /> IBALIK SA STAGING
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default StagingVault;
