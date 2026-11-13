import React, { useEffect, useState } from 'react';
import {
  X, Save, RefreshCw, CheckCircle2, AlertTriangle, Server, Cpu, FolderCog,
} from 'lucide-react';
import {
  direkGetSettings, direkSaveSettings, direkSetup,
  type DirekSettings, type SetupReport,
} from '../api';

const inputCls =
  'w-full bg-[#07080C] border border-gray-800 focus:border-[#D4AF37]/50 rounded px-2.5 py-1.5 text-xs font-mono text-gray-200 placeholder-gray-600 outline-none';

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label, hint, children,
}) => (
  <label className="block">
    <span className="block text-[10px] font-mono text-gray-500 uppercase tracking-wider mb-1">
      {label}
    </span>
    {children}
    {hint && <span className="block text-[9px] font-mono text-gray-600 mt-1">{hint}</span>}
  </label>
);

/** One-time setup: point the app at ComfyUI and kohya, then check both. */
export const SetupModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({
  isOpen, onClose,
}) => {
  const [settings, setSettings] = useState<DirekSettings>({});
  const [report, setReport] = useState<SetupReport | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const { settings: s } = await direkGetSettings();
      setSettings(s);
    } catch (e: any) {
      setError(e?.message || 'Hindi makuha ang settings.');
    }
  };

  const check = async () => {
    setChecking(true);
    try {
      setReport(await direkSetup());
    } catch (e: any) {
      setError(e?.message || 'Hindi ma-check ang setup.');
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setSaved(false);
    load();
    check();
  }, [isOpen]);

  if (!isOpen) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await direkSaveSettings(settings);
      setSaved(true);
      await check();
    } catch (e: any) {
      setError(e?.message || 'Hindi ma-save ang settings.');
    } finally {
      setSaving(false);
    }
  };

  const set = (key: keyof DirekSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setSettings(prev => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#080A10] border border-[#D4AF37]/50 rounded-xl max-w-2xl w-full max-h-[88vh] flex flex-col shadow-[0_0_50px_rgba(212,175,55,0.2)] overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b border-gray-800 bg-[#0F1219]">
          <div className="flex items-center gap-2">
            <FolderCog className="w-4 h-4 text-[#F6E076]" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              Setup
            </h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-800 text-gray-400">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* STATUS */}
          {report && (
            <div className="grid grid-cols-2 gap-2">
              <StatusCard
                icon={<Server size={12} />}
                title="ComfyUI"
                ok={report.comfyui.reachable}
                detail={report.comfyui.reachable
                  ? `${report.comfyui.checkpoints.length} checkpoints · ${report.comfyui.loras.length} LoRAs`
                  : report.comfyui.error || 'hindi maabot'}
              />
              <StatusCard
                icon={<Cpu size={12} />}
                title="kohya (training)"
                ok={report.trainer.available}
                detail={report.trainer.available ? 'handa' : report.trainer.reason || 'hindi available'}
              />
            </div>
          )}

          <p className="text-[10px] font-mono text-gray-500">
            Isang beses lang ito. I-type ang paths, pindutin ang SAVE — awtomatikong
            magagamit ng app. Naka-save sa{' '}
            <code className="text-[#00E5FF]">{report?.config_path || 'direk.config.json'}</code>.
          </p>

          {/* COMFYUI */}
          <div className="border border-gray-800 rounded-lg p-3 space-y-3">
            <div className="text-[10px] font-mono text-[#F6E076] uppercase tracking-wider">
              ComfyUI (libreng images)
            </div>
            <Field label="ComfyUI URL" hint="Kung sa ibang PC naka-ComfyUI, gamitin ang LAN IP nito.">
              <input value={settings.comfyui_url || ''} onChange={set('comfyui_url')}
                placeholder="http://127.0.0.1:8188" className={inputCls} />
            </Field>
            <Field label="Checkpoint">
              <input value={settings.comfyui_checkpoint || ''} onChange={set('comfyui_checkpoint')}
                placeholder="sd_xl_base_1.0.safetensors" className={inputCls} />
            </Field>
            {report && report.comfyui.checkpoints.length > 0 && (
              <div className="text-[9px] font-mono text-gray-600">
                Nakikita: {report.comfyui.checkpoints.slice(0, 6).join(', ')}
                {report.comfyui.checkpoints.length > 6 ? '…' : ''}
              </div>
            )}
            <Field label="LoRAs folder" hint="Dito ipapasa ng app ang na-train na LoRA. Dapat ito ang models/loras ng ComfyUI.">
              <input value={settings.comfyui_loras_dir || ''} onChange={set('comfyui_loras_dir')}
                placeholder="C:\\ComfyUI\\models\\loras" className={inputCls} />
            </Field>
          </div>

          {/* KOHYA */}
          <div className="border border-gray-800 rounded-lg p-3 space-y-3">
            <div className="text-[10px] font-mono text-[#F6E076] uppercase tracking-wider">
              kohya_ss (training)
            </div>
            <Field label="kohya folder" hint="Dapat may train_network.py sa loob.">
              <input value={settings.kohya_dir || ''} onChange={set('kohya_dir')}
                placeholder="C:\\kohya_ss" className={inputCls} />
            </Field>
            <Field label="Base model" hint="Path o HuggingFace id ng base model.">
              <input value={settings.kohya_base_model || ''} onChange={set('kohya_base_model')}
                placeholder="C:\\models\\sd_xl_base_1.0.safetensors" className={inputCls} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Python">
                <input value={settings.kohya_python || ''} onChange={set('kohya_python')}
                  placeholder="python3" className={inputCls} />
              </Field>
              <Field label="Output folder">
                <input value={settings.kohya_output_dir || ''} onChange={set('kohya_output_dir')}
                  placeholder="lora_runs" className={inputCls} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-[10px] font-mono text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={!!settings.kohya_accelerate}
                onChange={e => setSettings(prev => ({ ...prev, kohya_accelerate: e.target.checked }))}
                className="accent-[#F6E076]"
              />
              Gamitin ang <code>accelerate launch</code> (kung naka-setup)
            </label>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-[11px] font-mono text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {saved && !error && (
            <div className="flex items-center gap-2 text-[11px] font-mono text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded p-2.5">
              <CheckCircle2 size={13} /> Naka-save na. Awtomatikong gagamitin ng app.
            </div>
          )}
        </div>

        <div className="p-3 border-t border-gray-800 bg-[#0F1219] flex gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 px-3 py-2 rounded bg-gradient-to-br from-[#D4AF37] to-[#F6E076] text-black text-xs font-mono font-bold disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
            SAVE
          </button>
          <button
            onClick={check}
            disabled={checking}
            className="px-3 py-2 rounded border border-[#F6E076]/50 text-[#F6E076] text-xs font-mono font-bold disabled:opacity-40 flex items-center justify-center gap-1.5 hover:bg-[#F6E076]/10"
          >
            {checking ? <RefreshCw size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            CHECK
          </button>
        </div>
      </div>
    </div>
  );
};

const StatusCard: React.FC<{
  icon: React.ReactNode; title: string; ok: boolean; detail: string;
}> = ({ icon, title, ok, detail }) => (
  <div
    className={`rounded-lg border p-2.5 ${
      ok
        ? 'border-emerald-500/40 bg-emerald-500/10'
        : 'border-amber-500/40 bg-amber-500/10'
    }`}
  >
    <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-gray-300">
      {icon} {title}
      {ok
        ? <CheckCircle2 size={11} className="text-emerald-400 ml-auto" />
        : <AlertTriangle size={11} className="text-amber-400 ml-auto" />}
    </div>
    <div className={`text-[10px] font-mono mt-1 ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>
      {detail}
    </div>
  </div>
);
