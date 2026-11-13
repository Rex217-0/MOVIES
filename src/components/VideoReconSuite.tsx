import React, { useState, useEffect } from 'react';
import { 
  Video, Film, Sparkles, Play, Pause, RefreshCw, 
  Download, Maximize2, Radio, Check, Layers, Sliders
} from 'lucide-react';

interface VideoItem {
  id: string;
  type: string;
  url: string;
  prompt: string;
  aspect_ratio: '16:9' | '9:16';
  timestamp: string;
  model: string;
  details?: string;
}

const VIDEO_PRESETS = [
  {
    title: 'Orbital Fleet Hyperspace Jump',
    prompt: 'A tactical orbital battle fleet engaging hyperdrive engines above an icy gas giant, blue ion propulsion glow, 16:9 cinematic HUD reconnaissance',
    aspect: '16:9' as const,
  },
  {
    title: 'Tactical Drone Low-Altitude Canyon Sweep',
    prompt: 'Autonomous military stealth drone maneuvering at supersonic speeds through volcanic canyon chasms, thermal heat shimmer, HUD tracking data',
    aspect: '16:9' as const,
  },
  {
    title: 'Vertical Launch Interceptor (Mobile HUD)',
    prompt: 'First-person cockpit view of vertical rocket booster ignition ascending past storm clouds into starry low orbit, portrait telemetry overlays',
    aspect: '9:16' as const,
  },
  {
    title: 'Planetary Defense Orbital Shield Flare',
    prompt: 'A planetary kinetic defense barrier intercepting a stream of meteors, creating golden plasma ripples across the stratosphere',
    aspect: '16:9' as const,
  },
];

export const VideoReconSuite: React.FC<{
  onJumpToCockpit?: () => void;
}> = ({ onJumpToCockpit }) => {
  const [prompt, setPrompt] = useState(VIDEO_PRESETS[0].prompt);
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [duration, setDuration] = useState('10s');
  const [resolution, setResolution] = useState('720p');
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentVideo, setCurrentVideo] = useState<VideoItem | null>(null);
  const [videoList, setVideoList] = useState<VideoItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch existing videos
  useEffect(() => {
    fetch('/api/pilot/media/gallery')
      .then(res => res.json())
      .then(data => {
        if (data.items) {
          const vids = data.items.filter((i: any) => i.type === 'video');
          setVideoList(vids);
          if (vids.length > 0 && !currentVideo) {
            setCurrentVideo(vids[0]);
          }
        }
      })
      .catch(() => {});
  }, []);

  const handleGenerateVideo = async () => {
    if (!prompt.trim() || isGenerating) return;

    setIsGenerating(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/pilot/video/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          aspect_ratio: aspectRatio,
          duration,
          resolution,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Video generation failed');
      }

      if (data.item) {
        setCurrentVideo(data.item);
        setVideoList(prev => [data.item, ...prev.filter(v => v.id !== data.item.id)]);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Video generation failure. Please retry.');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#05060A] border border-[#D4AF37]/50 rounded-lg overflow-hidden shadow-[0_0_30px_rgba(212,175,55,0.15)] relative">
      {/* HEADER */}
      <div className="bg-gradient-to-r from-[#0F1219] via-[#1A1C23] to-[#0F1219] border-b border-[#D4AF37]/30 p-3 flex flex-wrap gap-2 justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#00E5FF]/10 rounded-md border border-[#00E5FF]/40 shadow-[0_0_12px_rgba(0,229,255,0.2)]">
            <Video className="text-[#00E5FF] w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white tracking-widest uppercase font-mono">
                Video Reconnaissance Suite
              </h2>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800 font-mono font-bold">
                OMNI FLASH · INTERACTIONS API
              </span>
            </div>
            <p className="text-[10px] text-gray-400 font-mono">
              Model: <code className="text-[#F6E076]">gemini-omni-1.2-flash</code> · Native 16:9 & 9:16 Video Generation
            </p>
          </div>
        </div>

        {onJumpToCockpit && (
          <button
            onClick={onJumpToCockpit}
            className="px-2.5 py-1 rounded bg-[#0d1017] hover:bg-[#161d2d] border border-gray-800 text-xs font-mono text-[#F6E076] transition-colors"
          >
            ← BACK TO COCKPIT
          </button>
        )}
      </div>

      {/* WORKSPACE */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-gray-800 min-h-0">
        
        {/* LEFT / CONTROLS (5 cols) */}
        <div className="lg:col-span-5 p-4 bg-[#07090F] flex flex-col justify-between space-y-4 overflow-y-auto">
          <div className="space-y-4">
            
            {/* ASPECT RATIO SELECTOR - MANDATORY FEATURE */}
            <div className="space-y-1.5">
              <label className="text-xs font-mono font-bold text-gray-300 flex items-center justify-between">
                <span>ASPECT RATIO (MANDATORY SPEC):</span>
                <span className="text-[10px] text-[#00E5FF]">{aspectRatio === '16:9' ? '16:9 Landscape' : '9:16 Portrait'}</span>
              </label>
              
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setAspectRatio('16:9')}
                  className={`p-2.5 rounded-lg border font-mono text-xs flex items-center justify-center gap-2 transition-all ${
                    aspectRatio === '16:9'
                      ? 'bg-[#121927] border-[#00E5FF] text-[#00E5FF] shadow-[0_0_12px_rgba(0,229,255,0.25)]'
                      : 'bg-black/50 border-gray-800 text-gray-400 hover:border-gray-700'
                  }`}
                >
                  <div className="w-5 h-3 border border-current rounded-sm"></div>
                  <span className="font-bold">16:9 Landscape</span>
                </button>

                <button
                  type="button"
                  onClick={() => setAspectRatio('9:16')}
                  className={`p-2.5 rounded-lg border font-mono text-xs flex items-center justify-center gap-2 transition-all ${
                    aspectRatio === '9:16'
                      ? 'bg-[#121927] border-[#00E5FF] text-[#00E5FF] shadow-[0_0_12px_rgba(0,229,255,0.25)]'
                      : 'bg-black/50 border-gray-800 text-gray-400 hover:border-gray-700'
                  }`}
                >
                  <div className="w-3 h-5 border border-current rounded-sm"></div>
                  <span className="font-bold">9:16 Portrait</span>
                </button>
              </div>
            </div>

            {/* DURATION & RESOLUTION */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <label className="text-[11px] font-mono text-gray-400">DURATION:</label>
                <select
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  className="w-full bg-[#0a0d14] border border-gray-800 rounded p-2 text-xs font-mono text-white focus:outline-none focus:border-[#D4AF37]"
                >
                  <option value="5s">5 Seconds</option>
                  <option value="10s">10 Seconds (Default)</option>
                  <option value="15s">15 Seconds</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-mono text-gray-400">RESOLUTION:</label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  className="w-full bg-[#0a0d14] border border-gray-800 rounded p-2 text-xs font-mono text-white focus:outline-none focus:border-[#D4AF37]"
                >
                  <option value="720p">720p HD (Default)</option>
                  <option value="1080p">1080p Full HD</option>
                  <option value="4k">4K Ultra</option>
                </select>
              </div>
            </div>

            {/* PROMPT TEXTAREA */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label htmlFor="video-prompt-input" className="text-xs font-mono font-bold text-gray-300">
                  RECONNAISSANCE DIRECTIVE PROMPT:
                </label>
                <span className="text-[10px] text-gray-500 font-mono">{prompt.length} chars</span>
              </div>
              <textarea
                id="video-prompt-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe cinematic video reconnaissance scene to generate via gemini-omni-1.2-flash..."
                disabled={isGenerating}
                rows={4}
                className="w-full bg-black/80 border border-gray-800 focus:border-[#00E5FF] focus:ring-1 focus:ring-[#00E5FF]/40 rounded-lg p-2.5 text-xs font-mono text-gray-200 resize-none disabled:opacity-50 transition-colors"
              />
            </div>

            {/* QUICK PRESETS */}
            <div className="space-y-1.5">
              <span className="text-[10px] text-gray-500 font-mono font-bold tracking-wider">
                TACTICAL MISSION PRESETS:
              </span>
              <div className="space-y-1">
                {VIDEO_PRESETS.map((p, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      setPrompt(p.prompt);
                      setAspectRatio(p.aspect);
                    }}
                    className="w-full text-left p-2 rounded bg-[#0c1018] hover:bg-[#141b29] border border-gray-800/80 text-[11px] font-mono text-gray-300 hover:text-white transition-colors flex justify-between items-center group"
                  >
                    <span className="truncate pr-2">{p.title}</span>
                    <span className="text-[9px] px-1 py-0.5 rounded bg-black/60 text-cyan-400 shrink-0 font-bold">
                      {p.aspect}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {errorMsg && (
              <div className="p-2.5 bg-red-950/40 border border-red-500/60 rounded text-red-300 text-xs font-mono">
                {errorMsg}
              </div>
            )}
          </div>

          {/* GENERATE BUTTON */}
          <div className="pt-2">
            <button
              type="button"
              onClick={handleGenerateVideo}
              disabled={isGenerating || !prompt.trim()}
              className="w-full py-3.5 bg-gradient-to-r from-[#00E5FF] via-cyan-400 to-[#00E5FF] text-black font-mono font-bold text-xs tracking-widest uppercase rounded-lg hover:brightness-110 active:brightness-95 transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(0,229,255,0.4)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isGenerating ? (
                <>
                  <RefreshCw size={15} className="animate-spin" />
                  <span>SYNTHESIZING VIDEO WITH OMNI FLASH...</span>
                </>
              ) : (
                <>
                  <Film size={15} />
                  <span>GENERATE VIDEO (GEMINI-OMNI-1.2-FLASH)</span>
                </>
              )}
            </button>
            <div className="text-[9px] text-gray-500 text-center font-mono mt-1.5">
              Powered by Google GenAI Interactions API · Model gemini-omni-1.2-flash
            </div>
          </div>
        </div>

        {/* RIGHT / VIEWER & GALLERY (7 cols) */}
        <div className="lg:col-span-7 p-4 bg-[#05070C] flex flex-col justify-between space-y-4">
          {/* VIDEO SCREEN / PLAYER */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider font-mono flex items-center gap-2">
                <Radio size={14} className="text-[#00E5FF]" /> Reconnaissance Visual Feed
              </h3>
              {currentVideo && (
                <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-800/40">
                  {currentVideo.aspect_ratio} · {currentVideo.model}
                </span>
              )}
            </div>

            <div className="w-full bg-black/90 border border-gray-800 rounded-xl overflow-hidden flex items-center justify-center min-h-[300px] max-h-[460px] relative shadow-[0_0_30px_rgba(0,0,0,0.8)]">
              {isGenerating ? (
                <div className="p-8 text-center space-y-3 z-10">
                  <div className="relative w-16 h-16 mx-auto">
                    <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20"></div>
                    <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-cyan-400 animate-spin"></div>
                    <Film className="absolute inset-0 m-auto text-cyan-400 w-6 h-6 animate-pulse" />
                  </div>
                  <div className="text-sm font-bold text-white font-mono">
                    GENERATING TACTICAL VIDEO
                  </div>
                  <p className="text-xs text-gray-400 max-w-sm font-mono">
                    Omni Flash neural pipeline formulating spatial temporal vectors ({aspectRatio})...
                  </p>
                </div>
              ) : currentVideo?.url ? (
                <div className={`relative flex items-center justify-center w-full h-full p-2 ${
                  currentVideo.aspect_ratio === '9:16' ? 'max-w-[280px] mx-auto' : ''
                }`}>
                  <video
                    src={currentVideo.url}
                    controls
                    autoPlay
                    loop
                    playsInline
                    className={`rounded-lg object-contain bg-black shadow-lg ${
                      currentVideo.aspect_ratio === '9:16' ? 'max-h-[430px] aspect-[9/16]' : 'w-full max-h-[430px] aspect-[16/9]'
                    }`}
                  />
                </div>
              ) : (
                <div className="p-8 text-center text-gray-500 font-mono text-xs space-y-2">
                  <Film size={28} className="mx-auto text-gray-600 mb-1" />
                  <div>No video feed loaded yet.</div>
                  <div className="text-[10px] text-gray-600">
                    Choose a preset or type a prompt on the left and click Generate.
                  </div>
                </div>
              )}
            </div>

            {currentVideo && (
              <div className="p-2.5 bg-[#0A0D15] rounded-lg border border-gray-800/80 text-[11px] font-mono text-gray-300 flex justify-between items-center gap-2">
                <div className="truncate">
                  <span className="text-[#F6E076] font-bold">PROMPT: </span>
                  <span>"{currentVideo.prompt}"</span>
                </div>
                {currentVideo.url && (
                  <a
                    href={currentVideo.url}
                    download={`recon-${currentVideo.id}.mp4`}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white shrink-0"
                    title="Download video"
                  >
                    <Download size={13} />
                  </a>
                )}
              </div>
            )}
          </div>

          {/* RECON GALLERY */}
          <div className="space-y-2 pt-2 border-t border-gray-800">
            <div className="flex justify-between items-center text-xs font-mono">
              <span className="text-gray-400 font-bold uppercase tracking-wider flex items-center gap-1.5">
                <Layers size={13} /> Mission Video Archives
              </span>
              <span className="text-[10px] text-gray-500">{videoList.length} items</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[140px] overflow-y-auto pr-1">
              {videoList.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setCurrentVideo(item)}
                  className={`p-2 rounded-lg border text-left font-mono transition-all ${
                    currentVideo?.id === item.id
                      ? 'bg-cyan-950/40 border-cyan-500 text-cyan-200'
                      : 'bg-black/40 border-gray-800 hover:border-gray-700 text-gray-400'
                  }`}
                >
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="font-bold text-[#F6E076]">{item.aspect_ratio}</span>
                    <span className="text-[9px] text-gray-500">{item.timestamp}</span>
                  </div>
                  <div className="text-[10px] truncate text-gray-300 mt-1">
                    {item.prompt}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
