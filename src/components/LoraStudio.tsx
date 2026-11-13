import React, { useState } from 'react';
import {
  direkLoraPlan, direkLoraDataset, direkTrainStatus, direkTrainStart, direkTrainCancel,
  direkLoraList, trainStreamUrl,
  type LoraBriefInput, type LoraPlanResult, type TrainJob, type TrainStatus, type LoraFile,
} from '../api';
import {
  Layers, Download, Loader2, AlertTriangle, Wand2, Film, CheckCircle2, Boxes,
  Play, Square, Terminal, Cpu,
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

  const [trainStatus, setTrainStatus] = useState<TrainStatus | null>(null);
  const [job, setJob] = useState<TrainJob | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [loras, setLoras] = useState<LoraFile[]>([]);
  const [useLora, setUseLora] = useState('');
  const [loraStrength, setLoraStrength] = useState(1);

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
    lora: useLora || undefined,
    loraStrength: useLora ? loraStrength : undefined,
  });

  const refreshTrainStatus = async () => {
    try {
      const s = await direkTrainStatus();
      setTrainStatus(s);
      if (s.job) {
        setJob(s.job);
        if (s.job.log.length) setLogLines(s.job.log);
      }
    } catch {
      // Trainer status is advisory; a failure here must not break the form.
    }
  };

  React.useEffect(() => {
    refreshTrainStatus();
    direkLoraList().then(r => setLoras(r.loras)).catch(() => {});
  }, []);

  // A freshly trained LoRA becomes available; refresh and select it.
  React.useEffect(() => {
    if (job?.status !== 'done' || !job.artifact) return;
    direkLoraList().then(r => {
      setLoras(r.loras);
      const name = job.artifact!.split('/').pop();
      if (name && r.loras.some(l => l.name === name)) setUseLora(name);
    }).catch(() => {});
  }, [job?.status, job?.artifact]);

  // Follow the live training log while a job runs.
  React.useEffect(() => {
    if (job?.status !== 'running') return;
    const es = new EventSource(trainStreamUrl());
    es.onmessage = e => setLogLines(prev => [...prev.slice(-300), e.data]);
    return () => es.close();
  }, [job?.status, job?.id]);

  // Poll job state so the UI notices done/failed without a reload.
  React.useEffect(() => {
    if (job?.status !== 'running') return;
    const t = setInterval(async () => {
      try {
        const s = await direkTrainStatus();
        if (s.job) setJob(s.job);
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(t);
  }, [job?.status]);

  const startTraining = async () => {
    setIsStarting(true);
    setError(null);
    setLogLines([]);
    try {
      const res = await direkTrainStart({ ...input(), epochs: 10 });
      setJob(res.job);
    } catch (e: any) {
      setError(e?.message || 'Hindi ma-start ang training.');
    } finally {
      setIsStarting(false);
    }
  };

  const cancelTraining = async () => {
    await direkTrainCancel();
    await refreshTrainStatus();
  };

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
    <div className="flex flex-col h-full bg-surface border border-subtle rounded-card overflow-hidden shadow-none">
 <div className="flex items-center gap-3 p-3 border-b border-subtle bg-page-soft">
 <div className="w-9 h-9 rounded-card bg-primary p-[1px]">
 <div className="w-full h-full bg-sunken rounded-card flex items-center justify-center">
 <Boxes className="w-4 h-4 text-primary" />
 </div>
 </div>
 <div>
 <h2 className="text-sm font-bold text-white tracking-wider uppercase">
 LoRA Studio
 </h2>
 <p className="text-[10px] text-muted">
 Movie Robo turns a brief into a LoRA training set — captions, config, metadata
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

 <div className="border-t border-subtle pt-3 space-y-3">
 <div className="text-[10px] text-muted uppercase tracking-wider">
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

 <div className="border-t border-subtle pt-3 space-y-2">
 <div className="text-[10px] text-muted uppercase tracking-wider">
 Gamitin ang na-train na LoRA
 </div>
 <select
 value={useLora}
 onChange={e => setUseLora(e.target.value)}
 className={inputCls}
 >
 <option value="">(wala — base model lang)</option>
 {loras.map(l => (
 <option key={l.name} value={l.name}>{l.name}</option>
 ))}
 </select>
 {useLora && (
 <Field label={`Strength: ${loraStrength.toFixed(2)}`}>
 <input
 type="range" min={0} max={2} step={0.05} value={loraStrength}
 onChange={e => setLoraStrength(Number(e.target.value))}
 className="w-full accent-[#F6E076]"
 />
 </Field>
 )}
 {loras.length === 0 && (
 <div className="text-[10px] text-dim">
 Wala pang na-train na LoRA. Mag-train muna sa ibaba.
 </div>
 )}
 </div>

 <label className="flex items-center gap-2 text-[10px] text-muted pt-1 cursor-pointer">
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
 className={`text-[10px] rounded-card p-2 border ${
 plan.images_available
 ? 'text-growth bg-growth-soft border-growth-soft'
 : 'text-primary bg-primary-soft border-primary'
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
 className="flex-1 px-3 py-2 rounded-card bg-primary text-primary-ink text-xs font-bold disabled:opacity-40 flex items-center justify-center gap-1.5"
 >
 {isPlanning ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
 PLAN
 </button>
 <button
 onClick={download}
 disabled={isDownloading || !title.trim()}
 className="flex-1 px-3 py-2 rounded-card border border-primary hover:text-primary-ink text-xs font-bold disabled:opacity-40 flex items-center justify-center gap-1.5 hover:bg-primary-hover"
 >
 {isDownloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
 DOWNLOAD .ZIP
 </button>
 </div>

 {/* TRAIN (kohya_ss) */}
 <div className="border-t border-subtle pt-3 space-y-2">
 <div className="flex items-center gap-2 text-[10px] text-muted uppercase tracking-wider">
 <Cpu size={11} /> Train (kohya_ss)
 </div>

 {trainStatus && !trainStatus.available && (
 <div className="text-[10px] text-primary bg-primary-soft border border-primary rounded-card p-2">
 {trainStatus.reason}
 </div>
 )}

 {job?.status === 'running' ? (
 <button
 onClick={cancelTraining}
 className="w-full px-3 py-2 rounded-card border border-red-500/40/40 text-red-300 text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-red-500/10"
 >
 <Square size={12} /> CANCEL TRAINING
 </button>
 ) : (
 <button
 onClick={startTraining}
 disabled={isStarting || !title.trim() || !trainStatus?.available}
 className="flex w-full items-center justify-center gap-1.5 rounded-pill bg-growth px-3 py-2 text-xs font-bold text-primary-ink disabled:opacity-40"
 >
 {isStarting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
 {isStarting ? 'GINAGAWA ANG DATASET...' : 'TRAIN LORA NGAYON'}
 </button>
 )}

 {job && (
 <div className="text-[10px] space-y-1">
 <div className="flex items-center gap-2">
 <span
 className={`px-1.5 py-0.5 rounded-card border uppercase ${
 job.status === 'running'
 ? 'text-primary-ink bg-primary'
 : job.status === 'done'
 ? 'text-growth border-growth-soft bg-growth-soft'
 : 'text-red-300 border-red-500/40/40 bg-red-500/10'
 }`}
 >
 {job.status}
 </span>
 <span className="text-muted truncate">{job.trigger}</span>
 </div>
 {job.artifact && (
 <div className="text-growth break-all">✓ {job.artifact}</div>
 )}
 {job.error && <div className="text-red-300">{job.error}</div>}
 <div className="text-dim break-all">output: {job.outputDir}</div>
 </div>
 )}

 {logLines.length > 0 && (
 <div className="bg-black/60 border border-subtle rounded-card p-2 max-h-40 overflow-y-auto">
 <div className="flex items-center gap-1 text-[9px] text-muted uppercase mb-1">
 <Terminal size={9} /> training log
 </div>
 {logLines.map((l, i) => (
 <div key={i} className="whitespace-pre-wrap break-all font-mono text-[10px] text-muted">
 {l}
 </div>
 ))}
 </div>
 )}
 </div>

 {error && (
 <div className="flex items-start gap-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/40/40 rounded-card p-2.5">
 <AlertTriangle size={13} className="mt-0.5 shrink-0" />
 <span>{error}</span>
 </div>
 )}
 {done && !error && (
 <div className="flex items-center gap-2 text-[11px] text-growth bg-growth-soft border border-growth-soft rounded-card p-2.5">
 <CheckCircle2 size={13} />
 Nai-download ang LoRA set.
 </div>
 )}
 </div>

 {/* PLAN PREVIEW */}
 <div className="border border-subtle rounded-card bg-sunken p-3 space-y-3 min-h-0">
 {!plan ? (
 <div className="text-center text-[11px] text-muted mt-10 space-y-2">
 <Layers className="w-7 h-7 mx-auto text-faint" />
 <p>Pindutin ang PLAN para makita ang LoRA training set.</p>
 </div>
 ) : (
 <>
 <div className="flex items-center gap-2 text-[10px] text-primary uppercase tracking-wider">
 <Film size={11} /> {plan.samples} samples
 </div>
 <div className="grid grid-cols-2 gap-2 text-[10px]">
 <Stat label="Trigger" value={plan.trigger} />
 <Stat label="Base model" value={plan.base_model.split('/').pop() || plan.base_model} />
 <Stat label="Character" value={plan.character.name} />
 <Stat label="Genre · Mood" value={`${plan.genre} · ${plan.mood}`} />
 </div>

 {plan.notes.length > 0 && (
 <ul className="text-[10px] text-muted space-y-1">
 {plan.notes.map((n, i) => <li key={i}>• {n}</li>)}
 </ul>
 )}

 {plan.references.length > 0 && (
 <div className="border-t border-subtle pt-2">
 <div className="text-[9px] text-muted uppercase tracking-wider mb-1">
 Reference titles
 </div>
 {plan.references.map((r, i) => (
 <div key={i} className="text-[10px] text-muted truncate">
 {r.title} {r.release_year ? `(${r.release_year})` : ''} · {r.source}
 </div>
 ))}
 </div>
 )}

 <div className="border-t border-subtle pt-2">
 <div className="text-[9px] text-muted uppercase tracking-wider mb-1">
 Files sa zip ({plan.artifacts.length})
 </div>
 <div className="max-h-40 overflow-y-auto space-y-0.5">
 {plan.artifacts.map((a, i) => (
 <div key={i} className="text-[9px] text-muted truncate">{a}</div>
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
 'w-full bg-sunken border border-subtle focus:border-primary rounded-card px-2.5 py-1.5 text-xs text-ink placeholder-faint outline-none';

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
 <label className="block">
 <span className="block text-[10px] text-muted uppercase tracking-wider mb-1">
 {label}
 </span>
 {children}
 </label>
);

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
 <div className="bg-page-soft border border-subtle rounded-card px-2 py-1.5">
 <div className="text-[8px] text-muted uppercase tracking-wider">{label}</div>
 <div className="text-ink truncate">{value}</div>
  </div>
);
