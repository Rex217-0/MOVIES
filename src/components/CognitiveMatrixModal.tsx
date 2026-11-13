import React, { useState, useEffect } from 'react';
import { Sparkles, Brain, Cpu, Shield, Clock, CheckCircle2, X } from 'lucide-react';
import { apiFetch } from '../api';

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
      apiFetch('/api/pilot/history')
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
 className="bg-sunken border border-primary rounded-panel max-w-3xl w-full max-h-[85vh] flex flex-col shadow-none overflow-hidden"
 role="dialog"
 aria-modal="true"
 aria-label="Cognitive Reasoning Matrix"
 >
 {/* Modal Header */}
 <div className="border-b border-subtle bg-page-soft p-4 flex justify-between items-center">
 <div className="flex items-center gap-3">
 <div className="p-2 bg-primary rounded-card">
 <Sparkles className="w-5 h-5 text-primary" />
 </div>
 <div>
 <h2 className="text-sm font-bold text-white uppercase tracking-wider">
 Cognitive Reasoning Matrix
 </h2>
 <p className="text-[11px] text-muted">
 gemini-2.5-flash · Structured JSON output
 </p>
 </div>
 </div>
 <button
 onClick={onClose}
 className="p-1.5 rounded-card bg-raised hover:bg-raised text-muted hover:text-white transition-colors"
 aria-label="Close modal"
 >
 <X size={18} />
 </button>
 </div>

 {/* Modal Body */}
 <div className="flex-1 overflow-y-auto p-5 space-y-6 text-xs text-ink">
 
 {/* Architecture Card */}
 <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
 <div className="p-3 bg-surface border border-edge rounded-card space-y-1">
 <div className="text-[10px] text-muted flex items-center gap-1.5">
 <Brain size={13} className="text-muted" /> REASONING MODEL
 </div>
 <div className="text-sm font-bold text-white">gemini-2.5-flash</div>
 <p className="text-[10px] text-muted">Deep reasoning engine pushing analytical depth.</p>
 </div>

 <div className="p-3 bg-surface border border-primary rounded-card space-y-1">
 <div className="text-[10px] text-muted flex items-center gap-1.5">
 <Sparkles size={13} className="text-primary" /> THINKING LEVEL
 </div>
 <div className="text-sm font-bold text-primary">responseMimeType: JSON</div>
 <p className="text-[10px] text-muted">Maximized reasoning for mission-critical directives.</p>
 </div>

 <div className="p-3 bg-surface border border-growth-soft rounded-card space-y-1">
 <div className="text-[10px] text-muted flex items-center gap-1.5">
 <Shield size={13} className="text-growth" /> TOKEN CONSTRAINT
 </div>
 <div className="text-sm font-bold text-growth">UNCONSTRAINED</div>
 <p className="text-[10px] text-muted">maxOutputTokens omitted to preserve full thinking depth.</p>
 </div>
 </div>

 {/* Reasoning Pipeline Explainer */}
 <div className="p-4 bg-surface rounded-card border border-subtle space-y-3">
 <h3 className="text-xs font-bold text-primary uppercase tracking-wider flex items-center gap-2">
 <Cpu size={14} /> Neural Pipeline Execution Flow
 </h3>
 <ol className="list-decimal list-inside space-y-1.5 text-ink text-[11px] leading-relaxed">
 <li>Commander issues tactical directive via the Cockpit Command Input.</li>
 <li>Safety gate checks directive against hazard criteria (kinetic strikes, protocol overrides).</li>
 <li>Real-time SSE event is dispatched to stream pilot thoughts to all connected displays.</li>
 <li>Direct request routed to <code className="text-muted">gemini-2.5-flash</code> with <code className="text-primary">responseMimeType: application/json</code>.</li>
 <li>Full strategic rationale and operational action synthesized and archived.</li>
 </ol>
 </div>

 {/* Execution History */}
 <div className="space-y-3">
 <div className="flex justify-between items-center">
 <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
 <Clock size={14} className="text-muted" /> Directive History & Thinking Traces
 </h3>
 <span className="text-[10px] text-muted">{history.length} records</span>
 </div>

 {loading ? (
 <div className="text-center py-6 text-muted">Loading neural archives...</div>
 ) : history.length === 0 ? (
 <div className="p-6 bg-black/40 rounded-card border border-dashed border-subtle text-center text-muted">
 No directives dispatched yet. Transmit a directive from the cockpit to observe thinking traces.
 </div>
 ) : (
 <div className="space-y-2.5">
 {history.map((item) => (
 <div key={item.id} className="p-3 bg-surface rounded-card border border-subtle space-y-2">
 <div className="flex justify-between items-center text-[10px]">
 <span className="text-primary font-bold">{item.intent}</span>
 <span className="text-muted">{item.timestamp} · {item.latency_ms}ms</span>
 </div>
 <div className="text-white text-xs font-sans font-medium">"{item.directive}"</div>
 <div className="text-[11px] text-muted bg-raised p-2 rounded-card border border-edge">
 <span className="font-bold text-primary">Synthesis: </span>
 {item.analysis}
 </div>
 </div>
 ))}
 </div>
 )}
 </div>
 </div>

 {/* Modal Footer */}
 <div className="p-3 bg-sunken border-t border-subtle flex justify-end">
 <button
 onClick={onClose}
 className="px-4 py-2 bg-raised hover:bg-raised text-white rounded-card text-xs font-bold transition-colors"
          >
            DISMISS
          </button>
        </div>
      </div>
    </div>
  );
};
