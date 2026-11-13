import React, { useEffect, useState } from 'react';
import { VipBattleRoom } from './components/VipBattleRoom';
import { TacticalRadarMap } from './components/TacticalRadarMap';
import { VideoReconSuite } from './components/VideoReconSuite';
import { ImageMatrixSuite } from './components/ImageMatrixSuite';
import { RenderVault } from './components/RenderVault';
import { CognitiveMatrixModal } from './components/CognitiveMatrixModal';
import { DirectorsChair } from './components/DirectorsChair';
import { LoraStudio } from './components/LoraStudio';
import { SetupModal } from './components/SetupModal';
import { direkStatus } from './api';
import { Sparkles, Radio, Terminal, Video, Wand2, Film, Clapperboard, Boxes, FolderCog } from 'lucide-react';

type TabId = 'direk' | 'lora' | 'cockpit' | 'radar' | 'video' | 'image' | 'vault';

type Tab = { id: TabId; label: string; icon: React.ComponentType<{ size?: number; className?: string }> };

const TABS: Tab[] = [
  { id: 'direk', label: 'Movie Robo', icon: Clapperboard },
  { id: 'lora', label: 'LoRA Studio', icon: Boxes },
  { id: 'cockpit', label: 'Battle Room', icon: Terminal },
  { id: 'radar', label: 'Radar', icon: Radio },
  { id: 'video', label: 'Video', icon: Video },
  { id: 'image', label: 'Image', icon: Wand2 },
  { id: 'vault', label: 'Vault', icon: Film },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('direk');
  const [isCognitiveModalOpen, setIsCognitiveModalOpen] = useState(false);
  const [isSetupOpen, setIsSetupOpen] = useState(false);
  const [textModel, setTextModel] = useState<string>('');
  const [textBackend, setTextBackend] = useState<string>('');

  useEffect(() => {
    let alive = true;
    const load = () => {
      direkStatus()
        .then((s: Awaited<ReturnType<typeof direkStatus>>) => {
          if (!alive) return;
          setTextModel(s.model);
          setTextBackend((s as any).text_backend || (s.gemini_key_configured ? 'gemini' : ''));
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-page text-ink">
      {/* TOP COMMAND DECK BAR */}
      <header className="panel-blur sticky top-0 z-20 border-b border-subtle">
        <div className="mx-auto flex max-w-[1700px] flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-primary text-primary-ink">
              <Clapperboard className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-[15px] font-bold tracking-tight text-ink">MOVIE CREATOR</h1>
                <span className="rounded-pill bg-primary-soft px-2 py-0.5 text-[10px] font-semibold text-primary">
                  Free suite
                </span>
              </div>
              <p className="text-[11px] text-dim">
                AI director · ideya hanggang publish
              </p>
            </div>
          </div>

          <nav className="flex flex-wrap items-center gap-1">
            {TABS.map(t => {
              const Icon = t.icon;
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-primary text-primary-ink'
                      : 'text-muted hover:bg-raised hover:text-ink'
                  }`}
                >
                  <Icon size={13} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <button onClick={() => setIsSetupOpen(true)} className="btn-ghost flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold">
              <FolderCog size={13} />
              <span>Setup</span>
            </button>
            <button onClick={() => setIsCognitiveModalOpen(true)} className="btn-primary flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold">
              <Sparkles size={13} />
              <span>Matrix</span>
            </button>
          </div>
        </div>
      </header>

      {/* MAIN VIEWPORT */}
      <main className="mx-auto flex min-h-0 w-full max-w-[1700px] flex-1 flex-col p-3 sm:p-4">
        <div className="flex-1 flex flex-col h-full min-h-[680px]">
          {activeTab === 'direk' ? (
            <DirectorsChair />
          ) : activeTab === 'lora' ? (
            <LoraStudio />
          ) : activeTab === 'cockpit' ? (
            <VipBattleRoom 
              onInspectThinking={() => setIsCognitiveModalOpen(true)}
              onOpenVideoRecon={() => setActiveTab('video')}
              onOpenImageMatrix={() => setActiveTab('image')}
            />
          ) : activeTab === 'radar' ? (
            <TacticalRadarMap />
          ) : activeTab === 'video' ? (
            <VideoReconSuite onJumpToCockpit={() => setActiveTab('cockpit')} />
          ) : activeTab === 'image' ? (
            <ImageMatrixSuite onJumpToCockpit={() => setActiveTab('cockpit')} />
          ) : (
            <RenderVault onJumpToVideoGen={() => setActiveTab('video')} />
          )}
        </div>
      </main>

      {/* FOOTER BAR */}
      <footer className="border-t border-subtle px-4 py-3 text-[11px] text-dim">
        <div className="mx-auto flex max-w-[1700px] flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-1.5 text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-growth"></span>
              Model: {textBackend ? textBackend : 'checking…'}
            </span>
            <span className="hidden sm:inline">Text: {textModel || '—'}</span>
          </div>
          <div>Movie Creator v1.0 · Movie Robo + Pilot Suite</div>
        </div>
      </footer>

      {/* MODAL */}
      <SetupModal isOpen={isSetupOpen} onClose={() => setIsSetupOpen(false)} />
      <CognitiveMatrixModal 
        isOpen={isCognitiveModalOpen} 
        onClose={() => setIsCognitiveModalOpen(false)} 
      />
    </div>
  );
}
