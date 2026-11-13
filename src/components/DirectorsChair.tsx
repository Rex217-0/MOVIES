import React, { useEffect, useRef, useState } from 'react';
import {
  direkChat, direkStatus, direkMarket, AiUnavailableError,
  type DirekChatMessage, type DirekStatus, type CatalogTitle, type SkillAction,
  type MarketIntel, type ShareStat,
} from '../api';
import {
  Clapperboard, Send, Loader2, AlertTriangle, BookOpen, Sparkles,
  ShieldAlert, Link2, Film, TrendingUp, Building2,
} from 'lucide-react';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  genre?: string | null;
  references?: CatalogTitle[];
  gate?: string | null;
  action?: SkillAction | null;
  actionError?: string | null;
  error?: string;
}

const STARTERS = [
  'Gusto ko ng horror na kwento sa probinsya, 3 minuto, nakakakaba.',
  'Gumawa ka ng romance na pelikula, 5 minuto, masaya.',
  'Sumulat ka ng logline para sa drama tungkol sa mangingisda, 3 minuto, mabigat.',
  'Gusto ko ng action na maikling pelikula, 2 minuto, tense.',
];

export const DirectorsChair: React.FC = () => {
  const [status, setStatus] = useState<DirekStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketIntel | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    direkStatus()
      .then(setStatus)
      .catch(e => setStatusError(e.message));
    direkMarket().then(setMarket).catch(() => setMarket(null));
  }, []);

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
      const result = await direkChat(history);
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
        },
      ]);
    } catch (e: any) {
      const message =
        e instanceof AiUnavailableError
          ? `${e.message} (${e.code})`
          : e?.message || 'Hindi maabot ang Direk service.';
      setTurns(prev => [...prev, { role: 'assistant', content: message, error: message }]);
    } finally {
      setIsSending(false);
    }
  };

  const available = status?.ok ?? false;

  return (
    <div className="flex flex-col h-full bg-[#0A0C10] border border-gray-800 rounded-lg overflow-hidden shadow-[0_0_30px_rgba(212,175,55,0.15)]">
      {/* HEADER */}
      <div className="flex flex-wrap gap-3 justify-between items-center p-3 border-b border-gray-800 bg-[#0F1219]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#D4AF37] to-[#F6E076] p-[1px]">
            <div className="w-full h-full bg-[#07080C] rounded-lg flex items-center justify-center">
              <Clapperboard className="w-4 h-4 text-[#F6E076]" />
            </div>
          </div>
          <div>
            <h2 className="text-sm font-bold text-white tracking-wider uppercase font-mono">
              Director's Chair · Direk
            </h2>
            <p className="text-[10px] text-gray-400 font-mono">
              AI Movie Director · IDEYA → SCRIPT → KARAKTER → SHOT LIST → VISUAL → EDIT → PUBLISH
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="flex items-center gap-1.5 text-gray-400">
            <BookOpen size={12} className="text-[#F6E076]" />
            {status ? `${status.reference_rows.toLocaleString()} titles` : '…'}
          </span>
          <span
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded border ${
              available
                ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
                : 'text-amber-300 border-amber-500/40 bg-amber-500/10'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${available ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {status ? (available ? status.model.toUpperCase() : 'AI UNAVAILABLE') : 'CHECKING…'}
          </span>
        </div>
      </div>

      {/* PIPELINE STRIP */}
      {status && (
        <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b border-gray-800 bg-[#080A0E]">
          {status.pipeline.map((stage, i) => (
            <React.Fragment key={stage.id}>
              <span
                className="text-[9px] font-mono font-bold tracking-wider px-2 py-0.5 rounded border border-[#D4AF37]/30 text-[#F6E076]/90 bg-[#D4AF37]/5"
                title={stage.description}
              >
                {stage.id}
              </span>
              {i < status.pipeline.length - 1 && <span className="text-gray-700 text-[10px]">›</span>}
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
          <div className="flex items-start gap-2 text-xs font-mono text-red-300 bg-red-500/10 border border-red-500/30 rounded p-3">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>Hindi makuha ang status: {statusError}</span>
          </div>
        )}

        {turns.length === 0 && !statusError && (
          <div className="max-w-2xl mx-auto mt-8 text-center space-y-4">
            <Sparkles className="w-8 h-8 text-[#F6E076] mx-auto" />
            <p className="text-sm text-gray-300 font-mono">
              Sabihin mo kay Direk ang ideya mo. Magtatanong muna siya kung kulang ang haba o mood.
            </p>
            <div className="grid sm:grid-cols-2 gap-2 pt-2">
              {STARTERS.map(s => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-left text-[11px] font-mono text-gray-300 hover:text-white bg-[#0F1219] hover:bg-[#141926] border border-gray-800 hover:border-[#D4AF37]/40 rounded p-2.5 transition-all"
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
          <div className="flex items-center gap-2 text-xs font-mono text-gray-400">
            <Loader2 size={14} className="animate-spin text-[#F6E076]" />
            Nag-iisip si Direk…
          </div>
        )}
      </div>

      {/* COMPOSER */}
      <div className="border-t border-gray-800 bg-[#0F1219] p-3">
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
            className="flex-1 bg-[#07080C] border border-gray-800 focus:border-[#D4AF37]/50 rounded px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 outline-none"
          />
          <button
            onClick={() => send(input)}
            disabled={isSending || !input.trim()}
            className="px-4 py-2 rounded bg-gradient-to-br from-[#D4AF37] to-[#F6E076] text-black text-xs font-mono font-bold disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <Send size={13} />
            SEND
          </button>
        </div>
      </div>
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
        className={`max-w-[85%] rounded-lg border p-3 space-y-2 ${
          isUser
            ? 'bg-[#141926] border-[#00E5FF]/20'
            : turn.error
              ? 'bg-red-500/10 border-red-500/30'
              : 'bg-[#0F1219] border-gray-800'
        }`}
      >
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider">
          {isUser ? (
            <span className="text-[#00E5FF]">COMMANDER</span>
          ) : (
            <span className="flex items-center gap-1.5 text-[#F6E076]">
              <Clapperboard size={11} /> DIREK
            </span>
          )}
          {turn.genre && (
            <span className="text-gray-500 normal-case">· genre: {turn.genre}</span>
          )}
        </div>

        <p className={`text-sm font-mono whitespace-pre-wrap ${turn.error ? 'text-red-200' : 'text-gray-200'}`}>
          {turn.content}
        </p>

        {turn.gate && (
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-amber-300">
            <ShieldAlert size={11} />
            Naghihintay ng detalye: <span className="font-bold">{turn.gate}</span>
          </div>
        )}

        {turn.actionError && (
          <div className="text-[10px] font-mono text-red-300">action: {turn.actionError}</div>
        )}

        {turn.action && (
          <div className="flex items-start gap-1.5 text-[10px] font-mono text-sky-300 bg-sky-500/5 border border-sky-500/20 rounded p-2">
            <Link2 size={11} className="mt-0.5 shrink-0" />
            <span>
              Connector: <span className="font-bold">{turn.action.connector}</span> · {turn.action.skill} ·{' '}
              <span className="uppercase">{turn.action.status.replace('_', ' ')}</span>
            </span>
          </div>
        )}

        {turn.references && turn.references.length > 0 && (
          <div className="border-t border-gray-800 pt-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-gray-500 uppercase tracking-wider">
              <Film size={10} /> Reference titles
            </div>
            {turn.references.map((r, i) => (
              <div key={i} className="text-[10px] font-mono text-gray-400">
                <span className="text-gray-300">{r.title}</span>
                {r.release_year ? ` (${r.release_year})` : ''} · {r.listed_in}
                {typeof r.rating === 'number' ? ` · ★ ${r.rating.toFixed(1)}` : ''}
                <span className="text-gray-600"> · {r.source}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const MarketSidebar: React.FC<{ market: MarketIntel }> = ({ market }) => (
  <aside className="hidden lg:flex w-64 shrink-0 flex-col border-l border-gray-800 bg-[#080A0E] overflow-y-auto">
    <div className="p-3 border-b border-gray-800">
      <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold text-[#F6E076] uppercase tracking-wider">
        <TrendingUp size={12} /> Market Intel
      </div>
      <p className="text-[9px] font-mono text-gray-500 mt-1">Totoong box-office stats</p>
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
    <div className="p-3 border-b border-gray-800/60">
      <div className="flex items-center gap-1.5 text-[9px] font-mono text-gray-500 uppercase tracking-wider mb-2">
        {icon} {title}
      </div>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="text-[10px] font-mono">
            <div className="flex justify-between text-gray-300">
              <span className="truncate">{r.name}</span>
              <span className="text-[#F6E076] ml-2 shrink-0">{r.marketShare}</span>
            </div>
            <div className="h-1 mt-0.5 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#D4AF37] to-[#F6E076]"
                style={{ width: r.marketShare }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
