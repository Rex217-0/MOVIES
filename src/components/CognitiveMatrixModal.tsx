import React, { useState, useEffect } from 'react';
import { Sparkles, Brain, Cpu, Shield, Clock, CheckCircle2, X } from 'lucide-react';

interface HistoryRecord {
  id: string;
  timestamp: string;
  directive: string;
  intent: string;
  action: string;
  analysis: string;
  latency_ms: number;
}

export const CognitiveMatrixModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      fetch('/api/pilot/history')
        .then(res => res.json())
        .then(data => {
          if (data.history) setHistory(data.history);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div 
        className="bg-[#080A10] border border-[#D4AF37]/50 rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-[0_0_50px_rgba(212,175,55,0.2)] overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Cognitive Reasoning Matrix"
      >
        {/* Modal Header */}
        <div className="p-4 bg-gradient-to-r from-[#0F131D] to-[#161B26] border-b border-gray-800 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[#D4AF37]/10 rounded border border-[#D4AF37]/40">
              <Sparkles className="w-5 h-5 text-[#F6E076]" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                Cognitive Reasoning Matrix
              </h2>
              <p className="text-[11px] font-mono text-[#00E5FF]">
                gemini-4-carbon · ThinkingLevel.HIGH · Uncapped Tokens
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-gray-900 hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
            aria-label="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6 text-xs text-gray-300 font-mono">
          
          {/* Architecture Card */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="p-3 bg-[#0c1017] border border-cyan-500/30 rounded-lg space-y-1">
              <div className="text-[10px] text-gray-400 flex items-center gap-1.5">
                <Brain size={13} className="text-cyan-400" /> REASONING MODEL
              </div>
              <div className="text-sm font-bold text-white">gemini-4-carbon</div>
              <p className="text-[10px] text-gray-400">Deep reasoning engine pushing analytical depth.</p>
            </div>

            <div className="p-3 bg-[#0c1017] border border-amber-500/30 rounded-lg space-y-1">
              <div className="text-[10px] text-gray-400 flex items-center gap-1.5">
                <Sparkles size={13} className="text-amber-400" /> THINKING LEVEL
              </div>
              <div className="text-sm font-bold text-[#F6E076]">ThinkingLevel.HIGH</div>
              <p className="text-[10px] text-gray-400">Maximized reasoning for mission-critical directives.</p>
            </div>

            <div className="p-3 bg-[#0c1017] border border-green-500/30 rounded-lg space-y-1">
              <div className="text-[10px] text-gray-400 flex items-center gap-1.5">
                <Shield size={13} className="text-green-400" /> TOKEN CONSTRAINT
              </div>
              <div className="text-sm font-bold text-green-400">UNCONSTRAINED</div>
              <p className="text-[10px] text-gray-400">maxOutputTokens omitted to preserve full thinking depth.</p>
            </div>
          </div>

          {/* Reasoning Pipeline Explainer */}
          <div className="p-4 bg-[#0a0d14] rounded-lg border border-gray-800 space-y-3">
            <h3 className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider flex items-center gap-2">
              <Cpu size={14} /> Neural Pipeline Execution Flow
            </h3>
            <ol className="list-decimal list-inside space-y-1.5 text-gray-300 text-[11px] leading-relaxed">
              <li>Commander issues tactical directive via the Cockpit Command Input.</li>
              <li>Safety gate checks directive against hazard criteria (kinetic strikes, protocol overrides).</li>
              <li>Real-time SSE event is dispatched to stream pilot thoughts to all connected displays.</li>
              <li>Direct request routed to <code className="text-cyan-300">gemini-4-carbon</code> with <code className="text-amber-300">thinkingConfig: &#123; thinkingLevel: ThinkingLevel.HIGH &#125;</code>.</li>
              <li>Full strategic rationale and operational action synthesized and archived.</li>
            </ol>
          </div>

          {/* Execution History */}
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                <Clock size={14} className="text-[#00E5FF]" /> Directive History & Thinking Traces
              </h3>
              <span className="text-[10px] text-gray-500">{history.length} records</span>
            </div>

            {loading ? (
              <div className="text-center py-6 text-gray-500">Loading neural archives...</div>
            ) : history.length === 0 ? (
              <div className="p-6 bg-black/40 rounded-lg border border-dashed border-gray-800 text-center text-gray-500">
                No directives dispatched yet. Transmit a directive from the cockpit to observe thinking traces.
              </div>
            ) : (
              <div className="space-y-2.5">
                {history.map((item) => (
                  <div key={item.id} className="p-3 bg-[#0d1017] rounded border border-gray-800/80 space-y-2">
                    <div className="flex justify-between items-center text-[10px]">
                      <span className="text-[#D4AF37] font-bold">{item.intent}</span>
                      <span className="text-gray-500">{item.timestamp} · {item.latency_ms}ms</span>
                    </div>
                    <div className="text-white text-xs font-sans font-medium">"{item.directive}"</div>
                    <div className="text-[11px] text-cyan-300 bg-cyan-950/20 p-2 rounded border border-cyan-800/30">
                      <span className="font-bold text-[#F6E076]">Synthesis: </span>
                      {item.analysis}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-3 bg-[#0a0c12] border-t border-gray-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded text-xs font-bold font-mono transition-colors"
          >
            DISMISS
          </button>
        </div>
      </div>
    </div>
  );
};
