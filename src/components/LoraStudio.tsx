import React, { useState } from 'react';
import { direkLoraPlan, direkLoraDataset, type LoraBriefInput, type LoraPlanResult } from '../api';
import {
  Layers, Download, Loader2, AlertTriangle, Wand2, Film, CheckCircle2, Boxes,
} from 'lucide-react';

const GENRE_OPTIONS = [
  'horror', 'drama', 'action', 'romantic', 'comedy', 'thriller',
  'sci-fi', 'documentary', 'animation', 'anime',
];

const MOOD_OPTIONS = [
  'masaya', 'malungkot', 'nakakakaba', 'mabigat', 'magaan', 'madilim', 'inspirasyon',
];

export const LoraStudio: React.FC = () => {
  const [title, setTitle] = useState('Ang Huling Tala');
  const [genre, setGenre] = useState('horror');
  const [mood, setMood] = useState('madilim');
  const [duration, setDuration] = useState(5);
  const [trigger, setTrigger] = useState('');
  const [charName, setCharName] = useState('Bida');
  const [charLook, setCharLook] = useState('sariwang mukha, konsistent');
  const [charWardrobe, setCharWardrobe] = useState('');
  const [includeImages, setIncludeImages] = useState(true);

  const [plan, setPlan] = useState<LoraPlanResult | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const input = (): LoraBriefInput => ({
    title,
    genre,
    mood,
    durationMinutes: duration,
    trigger: trigger.trim() || undefined,
    character: {
      name: charName,
      look: charLook,
      wardrobe: charWardrobe || undefined,
    },
    images: includeImages,
  });

  const preview = async () => {
    setIsPlanning(true);
    setError(null);
    setDone(false);
    try {
      setPlan(await direkLoraPlan(input()));
    } catch (e: any) {
      setError(e?.message || 'Hindi makuha ang LoRA plan.');
    } finally {
      setIsPlanning(false);
    }
  };

  const download = async () => {
    setIsDownloading(true);
    setError(null);
    try {
      const blob = await direkLoraDataset(input());
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${plan?.trigger ?? 'direk'}_lora.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDone(true);
    } catch (e: any) {
      setError(e?.message || 'Hindi ma-download ang dataset.');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0A0C10] border border-gray-800 rounded-lg overflow-hidden shadow-[0_0_30px_rgba(212,175,55,0.15)]">
      <div className="flex items-center gap-3 p-3 border-b border-gray-800 bg-[#0F1219]">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#D4AF37] to-[#F6E076] p-[1px]">
          <div className="w-full h-full bg-[#07080C] rounded-lg flex items-center justify-center">
            <Boxes className="w-4 h-4 text-[#F6E076]" />
          </div>
        </div>
        <div>
          <h2 className="text-sm font-bold text-white tracking-wider uppercase font-mono">
            LoRA Studio
          </h2>
          <p className="text-[10px] text-gray-400 font-mono">
            Direk turns a brief into a LoRA training set — captions, config, metadata
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 grid lg:grid-cols-2 gap-4 min-h-0">
        {/* BRIEF FORM */}
        <div className="space-y-3">
          <Field label="Pamagat">
            <input value={title} onChange={e => setTitle(e.target.value)} className={inputCls} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Genre">
              <select value={genre} onChange={e => setGenre(e.target.value)} className={inputCls}>
                {GENRE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
            <Field label="Mood">
              <select value={mood} onChange={e => setMood(e.target.value)} className={inputCls}>
                {MOOD_OPTIONS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={`Haba: ${duration} min`}>
              <input
                type="range" min={1} max={60} value={duration}
                onChange={e => setDuration(Number(e.target.value))}
                className="w-full accent-[#F6E076]"
              />
            </Field>
            <Field label="Trigger (opsyonal)">
              <input
                value={trigger} onChange={e => setTrigger(e.target.value)}
                placeholder="auto: direk_<title>" className={inputCls}
              />
            </Field>
          </div>

          <div className="border-t border-gray-800 pt-3 space-y-3">
            <div className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">
              Character bible
            </div>
            <Field label="Pangalan">
              <input value={charName} onChange={e => setCharName(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Itsura (konsistent)">
              <input value={charLook} onChange={e => setCharLook(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Suot (opsyonal)">
              <input
                value={charWardrobe} onChange={e => setCharWardrobe(e.target.value)}
                placeholder="hal. pulang jacket" className={inputCls}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-[10px] font-mono text-gray-400 pt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={includeImages}
              onChange={e => setIncludeImages(e.target.checked)}
              className="accent-[#F6E076]"
            />
            Isama ang sample images (ComfyUI: libre · Gemini: paid)
          </label>

          {plan && (
            <div
              className={`text-[10px] font-mono rounded p-2 border ${
                plan.images_available
                  ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
                  : 'text-amber-300 bg-amber-500/10 border-amber-500/30'
              }`}
            >
              {plan.images_available
                ? `Gagawa ng hanggang ${plan.max_images} sample images via ${plan.image_backend === 'comfyui' ? 'ComfyUI (libre)' : 'Gemini'}.`
                : 'Text-only: walang image backend. Magpatakbo ng ComfyUI para sa libreng images, o mag-enable ng billing. Ang zip ay may captions, config, at IMAGES.md.'}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={preview}
              disabled={isPlanning || !title.trim()}
              className="flex-1 px-3 py-2 rounded bg-gradient-to-br from-[#D4AF37] to-[#F6E076] text-black text-xs font-mono font-bold disabled:opacity-40 flex items-center justify-center gap-1.5"
            >
              {isPlanning ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              PLAN
            </button>
            <button
              onClick={download}
              disabled={isDownloading || !title.trim()}
              className="flex-1 px-3 py-2 rounded border border-[#F6E076]/50 text-[#F6E076] text-xs font-mono font-bold disabled:opacity-40 flex items-center justify-center gap-1.5 hover:bg-[#F6E076]/10"
            >
              {isDownloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              DOWNLOAD .ZIP
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-[11px] font-mono text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {done && !error && (
            <div className="flex items-center gap-2 text-[11px] font-mono text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded p-2.5">
              <CheckCircle2 size={13} />
              Nai-download ang LoRA set.
            </div>
          )}
        </div>

        {/* PLAN PREVIEW */}
        <div className="border border-gray-800 rounded-lg bg-[#080A0E] p-3 space-y-3 min-h-0">
          {!plan ? (
            <div className="text-center text-[11px] font-mono text-gray-500 mt-10 space-y-2">
              <Layers className="w-7 h-7 mx-auto text-gray-700" />
              <p>Pindutin ang PLAN para makita ang LoRA training set.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-[10px] font-mono text-[#F6E076] uppercase tracking-wider">
                <Film size={11} /> {plan.samples} samples
              </div>
              <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                <Stat label="Trigger" value={plan.trigger} />
                <Stat label="Base model" value={plan.base_model.split('/').pop() || plan.base_model} />
                <Stat label="Character" value={plan.character.name} />
                <Stat label="Genre · Mood" value={`${plan.genre} · ${plan.mood}`} />
              </div>

              {plan.notes.length > 0 && (
                <ul className="text-[10px] font-mono text-gray-400 space-y-1">
                  {plan.notes.map((n, i) => <li key={i}>• {n}</li>)}
                </ul>
              )}

              {plan.references.length > 0 && (
                <div className="border-t border-gray-800 pt-2">
                  <div className="text-[9px] font-mono text-gray-500 uppercase tracking-wider mb-1">
                    Reference titles
                  </div>
                  {plan.references.map((r, i) => (
                    <div key={i} className="text-[10px] font-mono text-gray-400 truncate">
                      {r.title} {r.release_year ? `(${r.release_year})` : ''} · {r.source}
                    </div>
                  ))}
                </div>
              )}

              <div className="border-t border-gray-800 pt-2">
                <div className="text-[9px] font-mono text-gray-500 uppercase tracking-wider mb-1">
                  Files sa zip ({plan.artifacts.length})
                </div>
                <div className="max-h-40 overflow-y-auto space-y-0.5">
                  {plan.artifacts.map((a, i) => (
                    <div key={i} className="text-[9px] font-mono text-gray-500 truncate">{a}</div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const inputCls =
  'w-full bg-[#07080C] border border-gray-800 focus:border-[#D4AF37]/50 rounded px-2.5 py-1.5 text-xs font-mono text-gray-200 placeholder-gray-600 outline-none';

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <span className="block text-[10px] font-mono text-gray-500 uppercase tracking-wider mb-1">
      {label}
    </span>
    {children}
  </label>
);

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-[#0F1219] border border-gray-800 rounded px-2 py-1.5">
    <div className="text-[8px] text-gray-500 uppercase tracking-wider">{label}</div>
    <div className="text-gray-200 truncate">{value}</div>
  </div>
);
