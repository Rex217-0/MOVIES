import React, { useCallback, useEffect, useState } from 'react';
import {
  Loader2, Zap, AlertTriangle, RefreshCw, ChevronDown, ChevronUp, Download, PlugZap,
} from 'lucide-react';
import { direkSwarmCheck, direkSwarmGenerate, type SwarmCheck } from '../api';

/**
 * The SwarmUI outlet inside the Director's Chair.
 *
 * The status line is driven by the same server probe the Radar uses, so the dot
 * here and the dot on the map cannot disagree. Three states are kept apart on
 * purpose: not configured, configured but not answering, and alive. Showing
 * "off" as "broken" would send you debugging a server you never started.
 */
export const SwarmPanel: React.FC = () => {
  const [check, setCheck] = useState<SwarmCheck | null>(null);
  const [checking, setChecking] = useState(true);
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [steps, setSteps] = useState('20');
  const [cfgScale, setCfgScale] = useState('7');
  const [size, setSize] = useState('1024x1024');
  const [seed, setSeed] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [image, setImage] = useState<{ url: string; prompt: string; ms: number } | null>(null);

  const probe = useCallback(async () => {
    setChecking(true);
    try {
      setCheck(await direkSwarmCheck());
    } catch (e: any) {
      setCheck({
        reachable: false,
        url: '',
        error: e?.message || 'Hindi maabot ang SwarmUI check.',
        configured: true,
      });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { probe(); }, [probe]);

  const generate = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setImage(null);
    try {
      const [w, h] = size.split('x').map(Number);
      const result = await direkSwarmGenerate({
        prompt: text,
        negative: negative.trim() || undefined,
        width: w || undefined,
        height: h || undefined,
        steps: Number(steps) || undefined,
        cfgScale: Number(cfgScale) || undefined,
        seed: seed.trim() === '' ? undefined : Number(seed),
      });
      setImage({ url: result.item.url, prompt: result.item.prompt, ms: result.latency_ms });
    } catch (e: any) {
      setError(e?.message || 'Nabigo ang SwarmUI generation.');
    } finally {
      setBusy(false);
    }
  };

  const configured = check?.configured ?? false;
  const live = check?.reachable ?? false;
  const queue = check?.queue ?? {};
  const busyCount = Number(queue.waiting_gens ?? 0) + Number(queue.live_gens ?? 0);

  return (
    <div className="border-t border-subtle bg-sunken">
      {/* STATUS LINE — always visible, so the outlet is never a mystery */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11px]">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 font-semibold text-muted transition-colors hover:text-ink"
        >
          <PlugZap size={12} className={live ? 'text-growth' : 'text-dim'} />
          SwarmUI
          {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>

        {checking ? (
          <span className="flex items-center gap-1.5 text-dim">
            <Loader2 size={11} className="animate-spin" /> Sinusuri…
          </span>
        ) : !configured ? (
          <span className="text-dim">hindi naka-set up · itakda ang SWARMUI_URL</span>
        ) : live ? (
          <span className="flex items-center gap-1.5 text-growth">
            <span className="h-1.5 w-1.5 rounded-full bg-growth" />
            buhay
            {typeof check?.backend_status?.status === 'string' && (
              <span className="text-dim">· {check.backend_status.status}</span>
            )}
            {busyCount > 0 && <span className="text-primary">· {busyCount} nasa pila</span>}
            {typeof check?.latency_ms === 'number' && (
              <span className="text-faint">· {check.latency_ms}ms</span>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-primary" title={check?.detail}>
            <AlertTriangle size={11} /> hindi sumasagot
            {check?.url && <span className="text-faint">· {check.url}</span>}
          </span>
        )}

        <button
          onClick={probe}
          disabled={checking}
          className="ml-auto flex items-center gap-1 text-dim transition-colors hover:text-ink disabled:opacity-40"
          title="Suriin muli"
        >
          <RefreshCw size={11} className={checking ? 'animate-spin' : ''} /> CHECK
        </button>
      </div>

      {open && (
        <div className="max-h-[45vh] space-y-2 overflow-y-auto border-t border-subtle/60 px-3 py-2.5">
          {!configured && (
            <p className="text-[11px] leading-relaxed text-dim">
              Wala pang SwarmUI server na naka-configure. Kapag nag-set ka ng{' '}
              <code className="rounded bg-raised px-1 text-muted">SWARMUI_URL</code> (hal.{' '}
              <code className="rounded bg-raised px-1 text-muted">http://127.0.0.1:7801</code>),
              lalabas dito ang totoong status at makakapag-render ka ng image.
            </p>
          )}

          {configured && !live && (
            <div className="space-y-1 rounded-card border border-primary/30 bg-primary-soft p-2 text-[11px] text-primary">
              <div className="flex items-start gap-1.5">
                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                <span>{check?.error || 'Hindi sumasagot ang SwarmUI.'}</span>
              </div>
              {check?.detail && <div className="pl-4 text-dim">dahilan: {check.detail}</div>}
            </div>
          )}

          <div className="flex gap-2">
            <input
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  generate();
                }
              }}
              placeholder="Image prompt — hal. neon-lit Manila street, cinematic"
              className="flex-1 rounded-pill border border-edge bg-page-soft px-3 py-1.5 text-xs text-ink placeholder-faint outline-none focus:border-primary"
            />
            <button
              onClick={generate}
              disabled={busy || !prompt.trim() || !live}
              className="btn-primary flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold disabled:cursor-not-allowed disabled:opacity-40"
              title={!live ? 'Kailangan buhay ang SwarmUI bago makapag-render' : 'Mag-render ng isang image'}
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
              {busy ? 'RENDER…' : 'GENERATE'}
            </button>
          </div>

          <button
            onClick={() => setAdvanced(a => !a)}
            className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-dim transition-colors hover:text-muted"
          >
            {advanced ? <ChevronDown size={10} /> : <ChevronUp size={10} />} Settings
          </button>

          {advanced && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Field label="Steps" value={steps} onChange={setSteps} placeholder="20" />
              <Field label="CFG" value={cfgScale} onChange={setCfgScale} placeholder="7" />
              <Field label="Seed" value={seed} onChange={setSeed} placeholder="random" />
              <label className="col-span-2 text-[10px] uppercase tracking-wide text-dim">
                Size
                <select
                  value={size}
                  onChange={e => setSize(e.target.value)}
                  className="mt-1 w-full rounded-card border border-edge bg-page-soft px-2 py-1 text-[11px] normal-case tracking-normal text-ink outline-none focus:border-primary"
                >
                  <option value="1024x1024">1024 × 1024</option>
                  <option value="832x1216">832 × 1216 (portrait)</option>
                  <option value="1216x832">1216 × 832 (landscape)</option>
                  <option value="768x768">768 × 768</option>
                </select>
              </label>
              <label className="col-span-2 text-[10px] uppercase tracking-wide text-dim">
                Negative
                <input
                  value={negative}
                  onChange={e => setNegative(e.target.value)}
                  placeholder="blurry, low quality"
                  className="mt-1 w-full rounded-card border border-edge bg-page-soft px-2 py-1 text-[11px] normal-case tracking-normal text-ink placeholder-faint outline-none focus:border-primary"
                />
              </label>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-1.5 rounded-card border border-primary/30 bg-primary-soft p-2 text-[11px] text-primary">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {image && (
            <div className="space-y-1.5">
              <img
                src={image.url}
                alt={image.prompt}
                className="max-h-64 w-full rounded-card border border-subtle object-contain"
              />
              <div className="flex items-center justify-between text-[10px] text-dim">
                <span className="truncate">
                  {image.prompt} · {image.ms}ms · SwarmUI
                </span>
                <a
                  href={image.url}
                  download={`swarm-${Date.now()}.png`}
                  className="flex shrink-0 items-center gap-1 text-primary hover:opacity-80"
                >
                  <Download size={10} /> PNG
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Field: React.FC<{
  label: string; value: string; placeholder: string; onChange: (v: string) => void;
}> = ({ label, value, placeholder, onChange }) => (
  <label className="text-[10px] uppercase tracking-wide text-dim">
    {label}
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      inputMode="numeric"
      className="mt-1 w-full rounded-card border border-edge bg-page-soft px-2 py-1 text-[11px] normal-case tracking-normal text-ink placeholder-faint outline-none focus:border-primary"
    />
  </label>
);
