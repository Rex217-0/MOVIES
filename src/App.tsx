import React, { useState } from 'react';
import { VipBattleRoom } from './components/VipBattleRoom';
import { TacticalRadarMap } from './components/TacticalRadarMap';
import { VideoReconSuite } from './components/VideoReconSuite';
import { ImageMatrixSuite } from './components/ImageMatrixSuite';
import { RenderVault } from './components/RenderVault';
import { CognitiveMatrixModal } from './components/CognitiveMatrixModal';
import { DirectorsChair } from './components/DirectorsChair';
import { LoraStudio } from './components/LoraStudio';
import { SetupModal } from './components/SetupModal';
import { 
  ShieldAlert, Sparkles, Radio, BrainCircuit, 
  Layers, Terminal, Award, Video, Wand2, Film, Clapperboard, Boxes, FolderCog
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'direk' | 'lora' | 'cockpit' | 'radar' | 'video' | 'image' | 'vault'>('direk');
  const [isCognitiveModalOpen, setIsCognitiveModalOpen] = useState(false);
  const [isSetupOpen, setIsSetupOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#020306] text-gray-200 flex flex-col font-sans selection:bg-[#D4AF37]/30 selection:text-white">
      {/* TOP COMMAND DECK BAR */}
      <header className="border-b border-gray-800/80 bg-[#07090F]/90 backdrop-blur-md px-4 py-2.5 flex flex-wrap gap-3 justify-between items-center z-20">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#D4AF37] to-[#F6E076] p-[1px] shadow-[0_0_15px_rgba(212,175,55,0.3)]">
            <div className="w-full h-full bg-[#07080C] rounded-lg flex items-center justify-center">
              <Clapperboard className="w-4 h-4 text-[#F6E076]" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold text-white tracking-wider uppercase font-mono">
                MOVIE CREATOR
              </h1>
              <span className="flex items-center gap-1 text-[10px] font-mono font-bold text-[#F6E076] bg-[#D4AF37]/15 px-2 py-0.5 rounded border border-[#D4AF37]/40">
                <Award size={11} /> VIP SUITE
              </span>
            </div>
            <p className="text-[10px] text-gray-400 font-mono">
              AI Movie Director · Pilot Cockpit · Ideya hanggang Publish
            </p>
          </div>
        </div>

        {/* NAVIGATION & MODE TABS */}
        <div className="flex items-center gap-1 bg-[#0c101a] p-1 rounded-lg border border-gray-800 flex-wrap">
          <button
            onClick={() => setActiveTab('direk')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'direk'
                ? 'bg-[#241a0b] text-[#F6E076] shadow-[0_0_10px_rgba(246,224,118,0.25)] border border-[#F6E076]/40'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Clapperboard size={13} />
            <span>DIRECTOR'S CHAIR</span>
          </button>

          <button
            onClick={() => setActiveTab('lora')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'lora'
                ? 'bg-[#241a0b] text-[#F6E076] shadow-[0_0_10px_rgba(246,224,118,0.25)] border border-[#F6E076]/40'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Boxes size={13} />
            <span>LORA STUDIO</span>
          </button>

          <button
            onClick={() => setActiveTab('cockpit')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'cockpit'
                ? 'bg-[#182030] text-[#00E5FF] shadow-[0_0_10px_rgba(0,229,255,0.2)] border border-[#00E5FF]/40'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Terminal size={13} />
            <span>VIP BATTLE ROOM</span>
          </button>

          <button
            onClick={() => setActiveTab('radar')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'radar'
                ? 'bg-[#182030] text-[#00E5FF] shadow-[0_0_10px_rgba(0,229,255,0.2)] border border-[#00E5FF]/40'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Radio size={13} />
            <span>TACTICAL RADAR</span>
          </button>

          <button
            onClick={() => setActiveTab('video')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'video'
                ? 'bg-cyan-950/70 text-cyan-300 shadow-[0_0_10px_rgba(0,229,255,0.25)] border border-cyan-400/50'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Video size={13} />
            <span>VIDEO RECON</span>
          </button>

          <button
            onClick={() => setActiveTab('image')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'image'
                ? 'bg-amber-950/70 text-[#F6E076] shadow-[0_0_10px_rgba(246,224,118,0.25)] border border-amber-400/50'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Wand2 size={13} />
            <span>IMAGE MATRIX</span>
          </button>

          <button
            onClick={() => setActiveTab('vault')}
            className={`px-3 py-1.5 rounded-md text-xs font-mono font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'vault'
                ? 'bg-emerald-950/70 text-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.25)] border border-emerald-400/50'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Film size={13} />
            <span>RENDER VAULT (CINESTREAM)</span>
          </button>

          <button
            onClick={() => setIsSetupOpen(true)}
            className="px-3 py-1.5 rounded-md text-xs font-mono font-semibold text-gray-300 hover:bg-gray-800 border border-gray-700 transition-all flex items-center gap-1.5"
          >
            <FolderCog size={13} />
            <span>SETUP</span>
          </button>

          <button
            onClick={() => setIsCognitiveModalOpen(true)}
            className="px-3 py-1.5 rounded-md text-xs font-mono font-semibold text-[#F6E076] hover:bg-[#D4AF37]/20 border border-[#D4AF37]/30 transition-all flex items-center gap-1.5"
          >
            <Sparkles size={13} />
            <span>COGNITIVE MATRIX</span>
          </button>
        </div>
      </header>

      {/* MAIN VIEWPORT */}
      <main className="flex-1 p-2 sm:p-4 flex flex-col max-w-[1700px] w-full mx-auto min-h-0">
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
      <footer className="border-t border-gray-900 bg-[#05060A] px-4 py-2 text-[10px] font-mono text-gray-500 flex flex-wrap justify-between items-center gap-2">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-gray-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
            NEURAL PROTOCOL: GEMINI 2.5 FLASH
          </span>
          <span className="hidden sm:inline text-gray-600">|</span>
          <span className="hidden sm:inline">TEXT MODEL: GEMINI-2.5-FLASH</span>
          <span className="hidden sm:inline text-gray-600">|</span>
          <span className="hidden sm:inline">SAFEMED: ACTIVE</span>
        </div>
        <div className="text-gray-400">
          MOVIE CREATOR v1.0 · DIREK + PILOT SUITE
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
