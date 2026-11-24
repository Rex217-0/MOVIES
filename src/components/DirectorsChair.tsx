import React, { useEffect, useRef, useState } from 'react';
import {
  direkChat, direkStatus, direkMarket, direkChatHistory, AiUnavailableError,
  type DirekChatMessage, type DirekStatus, type CatalogTitle, type SkillAction,
  type ConnectorRunResult, assetDownloadUrl,
  type MarketIntel, type ShareStat,
} from '../api';
import {
  Clapperboard, Send, Loader2, AlertTriangle, BookOpen, Sparkles,
  ShieldAlert, Link2, Film, TrendingUp, Building2,
  Download,
} from 'lucide-react';
import { SwarmPanel } from './SwarmPanel';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  genre?: string | null;
  references?: CatalogTitle[];
  gate?: string | null;
  action?: SkillAction | null;
  actionError?: string | null;
  connector?: ConnectorRunResult | null;
  error?: string;
}

const STARTERS = [
  'Gusto ko ng horror na kwento sa probinsya, 3 minuto, nakakakaba.',
  'Gumawa ka ng romance na pelikula, 5 minuto, masaya.',
  'Sumulat ka ng logline para sa drama tungkol sa mangingisda, 3 minuto, mabigat.',
  'Gusto ko ng action na maikling pelikula, 2 minuto, tense.',
];

/** A stable per-browser conversation id, so a refresh restores the thread. */
function readThreadId(): string {
  try {
    const existing = localStorage.getItem('direk_thread');
    if (existing) return existing;
    const created =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('direk_thread', created);
    return created;
  } catch {
    // Private mode can block storage; a per-mount id still works for the session.
    return `t-${Date.now().toString(36)}`;
  }
}

export const DirectorsChair: React.FC = () => {
  const [status, setStatus] = useState<DirekStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketIntel | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [threadId] = useState<string>(() => readThreadId());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    direkStatus()
      .then(setStatus)
      .catch(e => setStatusError(e.message));
    direkMarket().then(setMarket).catch(() => setMarket(null));
  }, []);

  // Bring back the last turns so a refresh does not wipe the conversation.
  useEffect(() => {
    let cancelled = false;
    direkChatHistory(threadId)
      .then(saved => {
        if (cancelled || saved.length === 0) return;
        setTurns(
          saved.map(t => ({
            role: t.role,
            content: t.content,
          })),
        );
      })
      .catch(() => {
        // A cold or offline backend simply starts an empty thread.
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, isSending]);

  const send = async (text: string) => {
    const directive = text.trim();
    if (!directive || isSending) return;

    const history: DirekChatMessage[] = [
      ...turns
        .filter(t => !t.error)
        .map(t => ({ role: t.role, content: t.content })),
      { role: 'user', content: directive },
    ];
    setTurns(prev => [...prev, { role: 'user', content: directive }]);
    setInput('');
    setIsSending(true);

    try {
      const result = await direkChat(history, threadId);
      setTurns(prev => [
        ...prev,
        {
          role: 'assistant',
          content: result.reply,
          genre: result.reference_genre,
          references: result.references,
          gate: result.gate,
          action: result.action,
          actionError: result.action_error,
          connector: result.connector,
        },
      ]);
    } catch (e: any) {
      const message =
        e instanceof AiUnavailableError
          ? `${e.message} (${e.code})`
          : e?.message || 'Hindi maabot ang Movie Robo service.';
      setTurns(prev => [...prev, { role: 'assistant', content: message, error: message }]);
    } finally {
      setIsSending(false);
    }
  };

  const available = status?.ok ?? false;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-panel border border-subtle bg-surface">
 {/* HEADER */}
 <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle bg-page-soft p-3">
 <div className="flex items-center gap-3">
 <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-primary text-primary-ink">
 <Clapperboard className="h-4 w-4" />
 </div>
 <div>
 <h2 className="text-sm font-bold text-ink">
 Movie Robo
 </h2>
 <p className="text-[11px] text-dim">
 AI Movie Creator ng Moviecity · LJR Group · IDEYA → SCRIPT → KARAKTER → SHOT LIST → VISUAL → EDIT → PUBLISH
 </p>
 </div>
 </div>

 <div className="flex items-center gap-3 text-[11px]">
 <span className="flex items-center gap-1.5 text-muted">
 <BookOpen size={12} className="text-primary" />
 {status ? `${status.reference_rows.toLocaleString()} titles` : '…'}
 </span>
 <span
 className={`flex items-center gap-1.5 rounded-pill border px-2 py-0.5 ${
 available
 ? 'border-growth-soft/50 bg-growth-soft/15 text-growth'
 : 'border-primary/40 bg-primary-soft text-primary'
 }`}
 >
 <span className={`h-1.5 w-1.5 rounded-full ${available ? 'bg-growth' : 'bg-primary'}`} />
 {status ? (available ? status.model.toUpperCase() : 'AI UNAVAILABLE') : 'CHECKING…'}
 </span>
 </div>
 </div>

 {/* PIPELINE STRIP */}
 {status && (
 <div className="flex flex-wrap items-center gap-1 border-b border-subtle bg-sunken px-3 py-2">
 {status.pipeline.map((stage, i) => (
 <React.Fragment key={stage.id}>
 <span
 className="rounded-pill border border-edge bg-raised px-2 py-0.5 text-[10px] font-semibold tracking-wide text-muted"
 title={stage.description}
 >
 {stage.id}
 </span>
 {i < status.pipeline.length - 1 && <span className="text-faint">›</span>}
 </React.Fragment>
 ))}
 </div>
 )}

 {/* MAIN: conversation + market intel */}
 <div className="flex-1 flex min-h-0">
 <div className="flex-1 flex flex-col min-w-0">
 {/* CONVERSATION */}
 <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
 {statusError && (
 <div className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-card p-3">
 <AlertTriangle size={14} className="mt-0.5 shrink-0" />
 <span>Hindi makuha ang status: {statusError}</span>
 </div>
 )}

 {turns.length === 0 && !statusError && (
 <div className="max-w-2xl mx-auto mt-8 text-center space-y-4">
 <Sparkles className="mx-auto h-7 w-7 text-primary" />
 <p className="text-sm text-muted">
 Sabihin mo kay Movie Robo ang ideya mo. Magtatanong muna siya kung kulang ang haba o mood.
 </p>
 <div className="grid sm:grid-cols-2 gap-2 pt-2">
 {STARTERS.map(s => (
 <button
 key={s}
 onClick={() => send(s)}
 className="rounded-card border border-subtle bg-page-soft p-2.5 text-left text-xs text-muted transition-colors hover:border-edge hover:text-ink"
 >
 {s}
 </button>
 ))}
 </div>
 </div>
 )}

 {turns.map((turn, i) => (
 <TurnBubble key={i} turn={turn} />
 ))}

 {isSending && (
 <div className="flex items-center gap-2 text-xs text-dim">
 <Loader2 size={14} className="animate-spin text-primary" />
 Nag-iisip si Movie Robo…
 </div>
 )}
 </div>

 {/* COMPOSER */}
 <div className="border-t border-subtle bg-page-soft p-3">
 <div className="flex gap-2">
 <input
 value={input}
 onChange={e => setInput(e.target.value)}
 onKeyDown={e => {
 if (e.key === 'Enter' && !e.shiftKey) {
 e.preventDefault();
 send(input);
 }
 }}
 placeholder="Halimbawa: Gumawa ka ng horror na kwento sa probinsya, 3 minuto, nakakakaba."
 className="flex-1 rounded-pill border border-edge bg-sunken px-4 py-2 text-sm text-ink placeholder-faint outline-none focus:border-primary"
 />
 <button
 onClick={() => send(input)}
 disabled={isSending || !input.trim()}
 className="btn-primary flex items-center gap-1.5 px-4 py-2 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40"
 >
 <Send size={13} />
 SEND
 </button>
 </div>
 </div>
 <SwarmPanel />
 </div>
 {market && market.available && <MarketSidebar market={market} />}
 </div>
 </div>
 );
};

const TurnBubble: React.FC<{ turn: Turn }> = ({ turn }) => {
 const isUser = turn.role === 'user';
 return (
 <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
 <div
 className={`max-w-[85%] space-y-2 rounded-card border p-3 ${
 isUser
 ? 'border-edge bg-raised'
 : turn.error
 ? 'border-red-500/40 bg-red-500/10'
 : 'border-subtle bg-page-soft'
 }`}
 >
 <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider">
 {isUser ? (
 <span className="text-muted">You</span>
 ) : (
 <span className="flex items-center gap-1.5 text-primary">
 <Clapperboard size={11} /> Movie Robo
 </span>
 )}
 {turn.genre && (
 <span className="text-dim normal-case">· genre: {turn.genre}</span>
 )}
 </div>

 <p className={`whitespace-pre-wrap text-sm ${turn.error ? 'text-red-300' : 'text-ink'}`}>
 {turn.content}
 </p>

 {turn.gate && (
 <div className="flex items-center gap-1.5 text-[11px] text-primary">
 <ShieldAlert size={11} />
 Naghihintay ng detalye: <span className="font-bold">{turn.gate}</span>
 </div>
 )}

 {turn.actionError && (
 <div className="text-[11px] text-red-300">action: {turn.actionError}</div>
 )}

 {turn.action && (
 <div className="space-y-1.5 rounded-card border border-subtle bg-sunken p-2 text-[11px] text-muted">
 <div className="flex items-start gap-1.5">
 <Link2 size={11} className="mt-0.5 shrink-0" />
 <span>
 Connector: <span className="font-bold">{turn.action.connector}</span> · {turn.action.skill} ·{' '}
 <span className="uppercase">{turn.action.status.replace('_', ' ')}</span>
 </span>
 </div>
 {turn.connector && (
 <div className={turn.connector.ok ? 'text-growth' : 'text-primary'}>
 {turn.connector.ok ? '✔' : '!'} {turn.connector.note}
 </div>
 )}
 {turn.connector?.download && (
 <a
 href={assetDownloadUrl(turn.connector.download.name)}
 download
 className="inline-flex items-center gap-1 text-primary underline hover:opacity-80"
 >
 <Download size={11} /> {turn.connector.download.name}
 </a>
 )}
 {turn.connector?.assets?.map(a => (
 <a
 key={a.id}
 href={assetDownloadUrl(a.name)}
 download
 className="block text-muted underline hover:text-ink"
 >
 {a.kind} · {a.title}
 </a>
 ))}
 </div>
 )}

 {turn.references && turn.references.length > 0 && (
 <div className="space-y-1 border-t border-subtle pt-2">
 <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-dim">
 <Film size={10} /> Reference titles
 </div>
 {turn.references.map((r, i) => (
 <div key={i} className="text-[11px] text-muted">
 <span className="text-ink">{r.title}</span>
 {r.release_year ? ` (${r.release_year})` : ''} · {r.listed_in}
 {typeof r.rating === 'number' ? ` · ★ ${r.rating.toFixed(1)}` : ''}
 <span className="text-faint"> · {r.source}</span>
 </div>
 ))}
 </div>
 )}
 </div>
 </div>
 );
};

const MarketSidebar: React.FC<{ market: MarketIntel }> = ({ market }) => (
 <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-l border-subtle bg-sunken lg:flex">
 <div className="border-b border-subtle p-3">
 <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
 <TrendingUp size={12} /> Market Intel
 </div>
 <p className="mt-1 text-[10px] text-dim">Totoong box-office stats</p>
 </div>

 <MarketSection title="Top Genres" rows={market.top_genres} />
 <MarketSection title="Distributors" rows={market.top_distributors} icon={<Building2 size={11} />} />
 <MarketSection title="Production Methods" rows={market.production_methods} />
 <MarketSection title="Top Ratings" rows={market.ratings} />
 </aside>
);

const MarketSection: React.FC<{ title: string; rows: ShareStat[]; icon?: React.ReactNode }> = ({
 title, rows, icon,
}) => {
 if (!rows.length) return null;
 return (
 <div className="border-b border-subtle/60 p-3">
 <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-dim">
 {icon} {title}
 </div>
 <div className="space-y-1.5">
 {rows.map((r, i) => (
 <div key={i} className="text-[11px]">
 <div className="flex justify-between text-muted">
 <span className="truncate">{r.name}</span>
 <span className="ml-2 shrink-0 text-primary">{r.marketShare}</span>
 </div>
 <div className="mt-1 h-1 overflow-hidden rounded-pill bg-raised">
 <div
 className="h-full bg-primary"
                style={{ width: r.marketShare }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
