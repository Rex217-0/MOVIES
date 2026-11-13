import React, { useState, useEffect, useRef } from 'react';
import { apiFetch, thoughtStreamUrl } from '../api';
import { 
  BrainCircuit, Activity, Send, ShieldCheck, 
  Crosshair, TerminalSquare, AlertTriangle,
  Zap, Volume2, VolumeX, Trash2, Cpu, Sparkles, RefreshCw
} from 'lucide-react';

interface ProtocolItem {
  id: string;
  name: string;
  active: boolean;
  desc?: string;
}

const QUICK_DIRECTIVES = [
  { label: 'Sector Scan', prompt: 'Initiate 360-degree tactical sensor sweep of Sector 7-Delta' },
  { label: 'Defensive Barrier', prompt: 'Calibrate quantum shield harmonics to counteract incoming pulse radiation' },
  { label: 'Kinetic Strike (Hazard)', prompt: 'Initiate orbital kinetic strike on enemy cruiser dreadnought' },
  { label: 'SafeMed Audit', prompt: 'Execute SafeMed compliance diagnostic on pilot neuro-cardiac vitals' },
  { label: 'Moccasin Stealth', prompt: 'Engage Moccasin consistency protocol for sub-radar vector insertion' },
];

export const VipBattleRoom: React.FC<{
  onInspectThinking?: () => void;
  onOpenVideoRecon?: () => void;
  onOpenImageMatrix?: () => void;
}> = ({ onInspectThinking, onOpenVideoRecon, onOpenImageMatrix }) => {
  const [inputCommand, setInputCommand] = useState('');
  const [vitals, setVitals] = useState({ latency_ms: 0, tokens_per_sec: 0 });
  const [modelName, setModelName] = useState<string>('');
  const [protocols, setProtocols] = useState<ProtocolItem[]>([
    { id: 'A24_CINEMATOGRAPHY', name: 'A24_CINEMATOGRAPHY', active: true },
    { id: 'MOCCASIN_CONSISTENCY', name: 'MOCCASIN_CONSISTENCY', active: true },
    { id: 'SAFEMED_COMPLIANCE', name: 'SAFEMED_COMPLIANCE', active: true },
    { id: 'GEMINI_TEXT_REASONING', name: 'GEMINI_TEXT_REASONING', active: true },
  ]);
  const [logs, setLogs] = useState<string[]>([
    "SYS: Initializing Neural Link...",
    "SYS: Connecting to backend API...",
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [requiresConfirmation, setRequiresConfirmation] = useState<string | null>(null);
  const [audioFeedback, setAudioFeedback] = useState(false);
  
  const terminalRef = useRef<HTMLDivElement>(null);

  // Subtle tactical audio feedback using Web Audio API
  const playTacticalChime = (type: 'beep' | 'confirm' | 'alert') => {
    if (!audioFeedback || typeof window === 'undefined') return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'beep') {
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.04, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        osc.start();
        osc.stop(ctx.currentTime + 0.12);
      } else if (type === 'alert') {
        osc.frequency.setValueAtTime(320, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(240, ctx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } else {
        osc.frequency.setValueAtTime(520, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1040, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.05, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
        osc.start();
        osc.stop(ctx.currentTime + 0.18);
      }
    } catch {
      // Audio fallback
    }
  };

  // 1. Fetch Vitals (Polling every 5s)
  useEffect(() => {
    let isMounted = true;
    const fetchVitals = async () => {
      try {
        const res = await apiFetch('/api/pilot/status');
        if (res.ok && isMounted) {
          const data = await res.json();
          setVitals({
            latency_ms: data.latency_ms || 0,
            tokens_per_sec: data.tokens_per_sec || 0,
          });
          if (data.model) setModelName(data.model);
        }
      } catch {
        // Backend might not be ready yet
      }
    };
    
    fetchVitals();
    const vitalsInterval = setInterval(fetchVitals, 5000);
    return () => {
      isMounted = false;
      clearInterval(vitalsInterval);
    };
  }, []);

  // Fetch protocols
  useEffect(() => {
    apiFetch('/api/pilot/protocols')
      .then(res => res.json())
      .then(data => {
        if (data.protocols && Array.isArray(data.protocols)) {
          setProtocols(data.protocols);
        }
      })
      .catch(() => {});
  }, []);

  // 2. Thought Stream (SSE Connection) with auto-reconnect
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: any = null;

    const connectSSE = () => {
      try {
        eventSource = new EventSource(thoughtStreamUrl());
        
        eventSource.onmessage = (event) => {
          setLogs(prev => [...prev, `PILOT: ${event.data}`]);
          playTacticalChime('beep');
        };

        eventSource.onerror = () => {
          setLogs(prev => [...prev, `SYS: Thought Stream disconnected. Retrying...`]);
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          reconnectTimeout = setTimeout(connectSSE, 4000);
        };
      } catch {
        reconnectTimeout = setTimeout(connectSSE, 4000);
      }
    };

    connectSSE();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (eventSource) eventSource.close();
    };
  }, [audioFeedback]);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs]);

  // Protocol toggle handler
  const handleToggleProtocol = async (id: string) => {
    try {
      const res = await apiFetch('/api/pilot/protocol/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        const data = await res.json();
        setProtocols(prev => prev.map(p => p.id === id ? { ...p, active: data.protocol.active } : p));
        setLogs(prev => [...prev, `SYS: Protocol [${id}] toggled -> ${data.protocol.active ? 'ACTIVE' : 'OFFLINE'}`]);
      }
    } catch {
      // Fallback local toggle
      setProtocols(prev => prev.map(p => p.id === id ? { ...p, active: !p.active } : p));
    }
  };

  // 3. Execute Command
  const handleExecute = async (forceConfirm = false) => {
    if ((!inputCommand.trim() && !forceConfirm) || isProcessing) return;
    
    const commandText = forceConfirm ? requiresConfirmation : inputCommand;
    if (!commandText) return;

    setIsProcessing(true);
    setRequiresConfirmation(null);
    setLogs(prev => [...prev, `COMMANDER: ${commandText}`]);
    playTacticalChime(forceConfirm ? 'confirm' : 'beep');
    
    try {
      const res = await apiFetch('/api/pilot/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directive: commandText, confirmed: forceConfirm })
      });

      const data = await res.json();

      if (res.status === 503) {
        playTacticalChime('alert');
        setLogs(prev => [...prev, `SYS: ❌ AI UNAVAILABLE: ${data.error || 'The AI backend is unavailable.'}`]);
      } else if (data.status === 'requires_confirmation') {
        playTacticalChime('alert');
        setLogs(prev => [...prev, `SYS: ⚠️ CONFIRMATION REQUIRED FOR: ${data.action}`]);
        setRequiresConfirmation(data.action);
      } else if (data.status === 'queued' || data.status === 'success') {
        playTacticalChime('confirm');
        setLogs(prev => [...prev, `SYS: Directive acknowledged. Intent: ${data.intent || 'Processing'}`]);
        if (data.analysis) {
          setLogs(prev => [...prev, `PILOT: [ANALYSIS] ${data.analysis}`]);
        }
        setInputCommand('');
      } else if (data.error) {
        playTacticalChime('alert');
        setLogs(prev => [...prev, `SYS: ❌ ERROR: ${data.error}`]);
      }
    } catch {
      playTacticalChime('alert');
      setLogs(prev => [...prev, `SYS: ❌ API CONNECTION FAILED. Check backend.`]);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#05060A] border border-[#D4AF37]/50 rounded-lg overflow-hidden shadow-[0_0_30px_rgba(212,175,55,0.15)] relative">
      
      {/* VIP HEADER */}
      <div className="bg-gradient-to-r from-[#0F1219] via-[#1A1C23] to-[#0F1219] border-b border-[#D4AF37]/30 p-3 flex flex-wrap gap-2 justify-between items-center relative overflow-hidden">
        <div className="flex items-center gap-3 z-10">
          <div className="p-2 bg-[#D4AF37]/10 rounded-md border border-[#D4AF37]/50 shadow-[0_0_12px_rgba(212,175,55,0.2)]">
            <BrainCircuit className="text-[#F6E076] w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white tracking-widest uppercase">Pilot's Battle Room</h2>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#D4AF37]/20 text-[#F6E076] border border-[#D4AF37]/40 font-mono font-bold tracking-wider">
                VIP LEVEL 5
              </span>
            </div>
            <p className="text-[10px] text-[#00E5FF] font-mono flex items-center gap-1.5">
              <span>Neural Link: {modelName ? modelName.toUpperCase() : 'CHECKING…'}</span>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping"></span>
            </p>
          </div>
        </div>
        
        {/* REAL VITALS FROM BACKEND API & CONTROLS */}
        <div className="flex items-center gap-3 z-10 text-xs font-mono">
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-[#0A0C10] border border-gray-800">
            <span className="text-gray-500">LATENCY:</span>
            <span className={vitals.latency_ms > 0 ? "text-green-400 font-bold" : "text-gray-600"}>
              {vitals.latency_ms > 0 ? `${vitals.latency_ms}ms` : 'OFFLINE'}
            </span>
          </div>
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-[#0A0C10] border border-gray-800">
            <span className="text-gray-500">TOKENS/SEC:</span>
            <span className={vitals.tokens_per_sec > 0 ? "text-[#F6E076] font-bold" : "text-gray-600"}>
              {vitals.tokens_per_sec > 0 ? vitals.tokens_per_sec : 'OFFLINE'}
            </span>
          </div>

          {/* Sound Toggle */}
          <button
            onClick={() => setAudioFeedback(!audioFeedback)}
            title={audioFeedback ? 'Disable tactical audio' : 'Enable tactical audio feedback'}
            className="p-1.5 rounded bg-gray-900 border border-gray-700 text-gray-400 hover:text-white transition-colors"
            aria-label="Toggle audio feedback"
          >
            {audioFeedback ? <Volume2 size={14} className="text-[#00E5FF]" /> : <VolumeX size={14} />}
          </button>
        </div>
      </div>

      {/* MAIN COCKPIT AREA */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-0 md:divide-x divide-y md:divide-y-0 divide-gray-800 min-h-0">
        
        {/* LEFT: PILOT VITALS & PROTOCOLS */}
        <div className="p-4 space-y-5 bg-[#07080C] overflow-y-auto">
          <div className="space-y-2">
            <h3 className="text-xs text-gray-400 font-bold tracking-wider flex items-center justify-between">
              <span className="flex items-center gap-2"><Activity size={14} className="text-[#00E5FF]" /> CORE VITALS</span>
              <span className="text-[10px] text-green-400 font-mono">LIVE MATRIX</span>
            </h3>
            
            <div className="bg-[#0F1219] p-2.5 rounded border border-gray-800 space-y-2">
               <div className="flex justify-between items-center text-[11px]">
                 <span className="text-gray-400 font-mono">Cognitive Backend</span>
                 <div className={`text-xs font-bold font-mono ${vitals.latency_ms > 0 ? 'text-green-400' : 'text-amber-400'}`}>
                    {vitals.latency_ms > 0 ? 'CONNECTED' : 'HEALTH CHECK PENDING'}
                 </div>
               </div>

               <div className="pt-2 border-t border-gray-800/80 flex justify-between items-center text-[10px] text-gray-400 font-mono">
                 <span>Thinking Protocol</span>
                 <span className="text-[#F6E076] font-bold flex items-center gap-1">
                   <Sparkles size={11} /> Structured JSON
                 </span>
               </div>

               <div className="flex justify-between items-center text-[10px] text-gray-400 font-mono">
                 <span>Reasoning Engine</span>
                 <span className="text-cyan-400">gemini-2.5-flash</span>
               </div>
            </div>
          </div>

          {/* PROTOCOLS LIST */}
          <div className="space-y-2 pt-2 border-t border-gray-800">
            <div className="flex justify-between items-center">
              <h3 className="text-xs text-gray-400 font-bold tracking-wider flex items-center gap-2">
                <ShieldCheck size={14} className="text-[#D4AF37]" /> ACTIVE PROTOCOLS
              </h3>
              <span className="text-[9px] text-gray-500 font-mono">CLICK TO TOGGLE</span>
            </div>

            <div className="flex flex-wrap gap-2">
              {protocols.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleToggleProtocol(p.id)}
                  className={`text-left transition-all ${p.active ? 'opacity-100 ring-1 ring-green-500/30' : 'opacity-40 grayscale'}`}
                  title={p.desc || p.name}
                >
                  <Badge text={p.id} active={p.active} />
                </button>
              ))}
            </div>
          </div>

          {/* Quick Stats Panel */}
          <div className="p-3 bg-[#0c0e14] rounded border border-gray-800/80 space-y-2 text-[11px] font-mono">
            <div className="text-gray-400 flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Cpu size={12} className="text-cyan-400" /> Neural Sync Index</span>
              <span className="text-white font-bold">99.4%</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
              <div className="bg-gradient-to-r from-cyan-500 to-amber-400 h-full w-[99.4%] animate-pulse"></div>
            </div>
            
            {onInspectThinking && (
              <button
                onClick={onInspectThinking}
                className="w-full mt-2 py-1.5 px-2 bg-[#D4AF37]/10 hover:bg-[#D4AF37]/20 border border-[#D4AF37]/40 rounded text-[10px] text-[#F6E076] font-bold tracking-wider flex items-center justify-center gap-1.5 transition-colors"
              >
                <Zap size={12} /> OPEN COGNITIVE INSPECTOR
              </button>
            )}

            <div className="grid grid-cols-2 gap-1.5 pt-1">
              {onOpenVideoRecon && (
                <button
                  onClick={onOpenVideoRecon}
                  className="py-1 px-2 bg-cyan-950/40 hover:bg-cyan-900/50 border border-cyan-800/40 rounded text-[9px] text-cyan-300 font-bold tracking-wider flex items-center justify-center gap-1 transition-colors"
                >
                  VIDEO RECON
                </button>
              )}
              {onOpenImageMatrix && (
                <button
                  onClick={onOpenImageMatrix}
                  className="py-1 px-2 bg-amber-950/40 hover:bg-amber-900/50 border border-amber-800/40 rounded text-[9px] text-[#F6E076] font-bold tracking-wider flex items-center justify-center gap-1 transition-colors"
                >
                  IMAGE MATRIX
                </button>
              )}
            </div>
          </div>
        </div>

        {/* CENTER: HOLOGRAPHIC FEED / THOUGHT STREAM (SSE) */}
        <div className="p-4 flex flex-col bg-[#0A0C10] relative min-h-[300px]">
          <div className="absolute inset-0 bg-[linear-gradient(rgba(0,229,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,229,255,0.03)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none"></div>
          
          <div className="flex justify-between items-center mb-3 relative z-10">
            <h3 className="text-xs text-gray-400 font-bold tracking-wider flex items-center gap-2">
              <Crosshair size={14} className="text-[#00E5FF]" /> THOUGHT STREAM (SSE)
            </h3>
            
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[10px] font-mono text-cyan-400/80">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
                STREAM LIVE
              </span>
              <button
                onClick={() => setLogs(['SYS: Terminal buffer cleared by Commander.'])}
                title="Clear terminal log"
                className="text-gray-500 hover:text-gray-300 p-1"
                aria-label="Clear logs"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          
          <div 
            ref={terminalRef}
            tabIndex={0}
            role="region"
            aria-label="Pilot thought stream terminal logs"
            className="flex-1 overflow-y-auto space-y-2 relative z-10 font-mono text-xs pr-1 scrollbar-thin scrollbar-thumb-gray-800 scrollbar-track-transparent focus:outline-none focus:ring-1 focus:ring-cyan-500/40 rounded"
          >
            {logs.map((log, i) => (
              <div key={i} className={`p-2 rounded border-l-2 text-[11px] leading-relaxed transition-all ${
                log.startsWith('COMMANDER') ? 'border-[#F6E076] bg-[#F6E076]/5 text-[#F6E076]' : 
                log.startsWith('PILOT') ? 'border-[#00E5FF] bg-[#00E5FF]/5 text-[#00E5FF]' : 
                log.includes('ERROR') || log.includes('⚠️') || log.includes('SAFETY') ? 'border-red-500 bg-red-500/10 text-red-400' :
                'border-gray-700 bg-gray-800/30 text-gray-400'
              }`}>
                {log}
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT: TACTICAL CONTROLS */}
        <div className="p-4 bg-[#07080C] flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <h3 className="text-xs text-gray-400 font-bold tracking-wider flex items-center gap-2">
                <TerminalSquare size={14} className="text-[#F6E076]" /> COMMAND INPUT
              </h3>
              <span className="text-[10px] font-mono text-gray-500">DIRECTIVE TRANSMITTER</span>
            </div>

            <label htmlFor="directive-input" className="sr-only">Directive Input</label>
            <textarea 
              id="directive-input"
              value={inputCommand}
              onChange={(e) => setInputCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleExecute(false);
                }
              }}
              placeholder="Issue directive to Pilot (e.g., Scan Sector 4, engage orbital strike, calibrate shield...)"
              disabled={isProcessing}
              className="w-full h-28 bg-black/80 border border-gray-800 focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37]/50 rounded p-2.5 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none resize-none font-mono disabled:opacity-50 transition-colors"
            />

            {/* Quick Presets */}
            <div className="space-y-1.5">
              <div className="text-[10px] text-gray-500 font-mono font-semibold tracking-wider">QUICK DIRECTIVES:</div>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_DIRECTIVES.map((d, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setInputCommand(d.prompt)}
                    disabled={isProcessing}
                    className="px-2 py-1 bg-[#141721] hover:bg-[#1E2333] border border-gray-800 hover:border-gray-700 rounded text-[10px] font-mono text-gray-300 transition-colors text-left"
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* CONFIRMATION ALERT */}
          {requiresConfirmation && (
            <div className="my-3 p-3 bg-red-950/40 border border-red-500/70 rounded-md flex flex-col gap-2.5 animate-pulse">
              <div className="flex items-start gap-2 text-red-300 text-xs">
                <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold uppercase tracking-wider text-red-400">Security Gate Alert</div>
                  <span>Confirm lethal / high-risk directive: <b>{requiresConfirmation}</b></span>
                </div>
              </div>
              <div className="flex gap-2">
                <button 
                  type="button"
                  onClick={() => handleExecute(true)}
                  className="flex-1 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded shadow-[0_0_12px_rgba(239,68,68,0.5)] transition-all"
                >
                  YES, PROCEED
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRequiresConfirmation(null);
                    setLogs(prev => [...prev, 'SYS: Directive cancelled by Commander.']);
                  }}
                  className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-bold rounded transition-colors"
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}

          <div className="pt-3">
            <button 
              type="button"
              onClick={() => handleExecute(false)}
              disabled={isProcessing || !inputCommand.trim()}
              className="w-full py-3 bg-gradient-to-r from-[#D4AF37] to-[#F6E076] text-black font-bold text-xs tracking-widest uppercase rounded hover:brightness-110 active:brightness-95 transition-all flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(212,175,55,0.4)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isProcessing ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  <span>TRANSMITTING DIRECTIVE...</span>
                </>
              ) : (
                <>
                  <Send size={14} />
                  <span>TRANSMIT DIRECTIVE</span>
                </>
              )}
            </button>
            <div className="text-[9px] text-gray-600 text-center font-mono mt-1.5">
              Press Ctrl+Enter or Transmit Directive
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const Badge: React.FC<{ text: string; active?: boolean }> = ({ text, active = true }) => (
  <span className={`px-2 py-1 rounded text-[10px] font-mono flex items-center gap-1.5 border transition-all ${
    active 
      ? 'bg-[#1A1C23] border-gray-700 text-gray-200' 
      : 'bg-black/40 border-gray-900 text-gray-600'
  }`}>
    <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`}></span>
    {text}
  </span>
);

export default VipBattleRoom;
