import React, { useState, useEffect } from 'react';
import { apiFetch } from '../api';
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
    apiFetch('/api/pilot/media/gallery')
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
      const res = await apiFetch('/api/pilot/video/generate', {
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
      if (res.status === 503) {
        throw new Error(data.error || 'Video generation is unavailable.');
      }
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
    <div className="flex flex-col h-full bg-sunken border border-primary rounded-card overflow-hidden shadow-none relative">
 {/* HEADER */}
 <div className="bg-page-soft border-b border-primary p-3 flex flex-wrap gap-2 justify-between items-center">
 <div className="flex items-center gap-3">
 <div className="p-2 bg-raised rounded-md border border-edge shadow-none">
 <Video className="text-muted w-5 h-5 animate-pulse" />
 </div>
 <div>
 <div className="flex items-center gap-2">
 <h2 className="text-sm font-bold text-white tracking-widest uppercase">
 Video Reconnaissance Suite
 </h2>
 <span className="text-[9px] px-1.5 py-0.5 rounded-card bg-raised text-muted border border-edge font-bold">
 OMNI FLASH · INTERACTIONS API
 </span>
 </div>
 <p className="text-[10px] text-muted">
 Model: <code className="text-primary">gemini-omni-1.2-flash</code> (paid tier only - currently unavailable)
 </p>
 </div>
 </div>

 {onJumpToCockpit && (
 <button
 onClick={onJumpToCockpit}
 className="px-2.5 py-1 rounded-card bg-surface hover:bg-raised border border-subtle text-xs text-primary transition-colors"
 >
 ← BACK TO COCKPIT
 </button>
 )}
 </div>

 {/* WORKSPACE */}
 <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-gray-800 min-h-0">
 
 {/* LEFT / CONTROLS (5 cols) */}
 <div className="lg:col-span-5 p-4 bg-sunken flex flex-col justify-between space-y-4 overflow-y-auto">
 <div className="space-y-4">
 
 {/* ASPECT RATIO SELECTOR - MANDATORY FEATURE */}
 <div className="space-y-1.5">
 <label className="text-xs font-bold text-ink flex items-center justify-between">
 <span>ASPECT RATIO (MANDATORY SPEC):</span>
 <span className="text-[10px] text-muted">{aspectRatio === '16:9' ? '16:9 Landscape' : '9:16 Portrait'}</span>
 </label>
 
 <div className="grid grid-cols-2 gap-2">
 <button
 type="button"
 onClick={() => setAspectRatio('16:9')}
 className={`p-2.5 rounded-card border text-xs flex items-center justify-center gap-2 transition-all ${
 aspectRatio === '16:9'
 ? 'bg-raised border-edge text-muted shadow-none'
 : 'bg-black/50 border-subtle text-muted hover:border-edge'
 }`}
 >
 <div className="w-5 h-3 border border-current rounded-sm"></div>
 <span className="font-bold">16:9 Landscape</span>
 </button>

 <button
 type="button"
 onClick={() => setAspectRatio('9:16')}
 className={`p-2.5 rounded-card border text-xs flex items-center justify-center gap-2 transition-all ${
 aspectRatio === '9:16'
 ? 'bg-raised border-edge text-muted shadow-none'
 : 'bg-black/50 border-subtle text-muted hover:border-edge'
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
 <label className="text-[11px] text-muted">DURATION:</label>
 <select
 value={duration}
 onChange={(e) => setDuration(e.target.value)}
 className="w-full bg-surface border border-subtle rounded-card p-2 text-xs text-white focus:outline-none focus:border-primary"
 >
 <option value="5s">5 Seconds</option>
 <option value="10s">10 Seconds (Default)</option>
 <option value="15s">15 Seconds</option>
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-[11px] text-muted">RESOLUTION:</label>
 <select
 value={resolution}
 onChange={(e) => setResolution(e.target.value)}
 className="w-full bg-surface border border-subtle rounded-card p-2 text-xs text-white focus:outline-none focus:border-primary"
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
 <label htmlFor="video-prompt-input" className="text-xs font-bold text-ink">
 RECONNAISSANCE DIRECTIVE PROMPT:
 </label>
 <span className="text-[10px] text-muted">{prompt.length} chars</span>
 </div>
 <textarea
 id="video-prompt-input"
 value={prompt}
 onChange={(e) => setPrompt(e.target.value)}
 placeholder="Describe a cinematic video scene (video generation is currently unavailable)..."
 disabled={isGenerating}
 rows={4}
 className="w-full bg-black/80 border border-subtle focus:border-edge focus:ring-1 focus:ring-edge rounded-card p-2.5 text-xs text-ink resize-none disabled:opacity-50 transition-colors"
 />
 </div>

 {/* QUICK PRESETS */}
 <div className="space-y-1.5">
 <span className="text-[10px] text-muted font-bold tracking-wider">
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
 className="w-full text-left p-2 rounded-card bg-surface hover:bg-raised border border-subtle text-[11px] text-ink hover:text-white transition-colors flex justify-between items-center group"
 >
 <span className="truncate pr-2">{p.title}</span>
 <span className="text-[9px] px-1 py-0.5 rounded-card bg-black/60 text-muted shrink-0 font-bold">
 {p.aspect}
 </span>
 </button>
 ))}
 </div>
 </div>

 {errorMsg && (
 <div className="p-2.5 bg-red-500/10 border border-red-500/40/40 rounded-card text-red-300 text-xs">
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
 className="w-full py-3.5 bg-raised text-primary-ink font-bold text-xs tracking-widest uppercase rounded-card hover:brightness-110 active:brightness-95 transition-all flex items-center justify-center gap-2 shadow-none disabled:opacity-40 disabled:cursor-not-allowed"
 >
 {isGenerating ? (
 <>
 <RefreshCw size={15} className="animate-spin" />
 <span>SYNTHESIZING VIDEO WITH OMNI FLASH...</span>
 </>
 ) : (
 <>
 <Film size={15} />
 <span>GENERATE VIDEO</span>
 </>
 )}
 </button>
 <div className="text-[9px] text-muted text-center mt-1.5">
 Video generation requires a paid Gemini tier and is currently unavailable.
 </div>
 </div>
 </div>

 {/* RIGHT / VIEWER & GALLERY (7 cols) */}
 <div className="lg:col-span-7 p-4 bg-sunken flex flex-col justify-between space-y-4">
 {/* VIDEO SCREEN / PLAYER */}
 <div className="space-y-2">
 <div className="flex justify-between items-center">
 <h3 className="text-xs font-bold text-ink uppercase tracking-wider flex items-center gap-2">
 <Radio size={14} className="text-muted" /> Reconnaissance Visual Feed
 </h3>
 {currentVideo && (
 <span className="text-[10px] text-muted bg-raised px-2 py-0.5 rounded-card border border-edge">
 {currentVideo.aspect_ratio} · {currentVideo.model}
 </span>
 )}
 </div>

 <div className="w-full bg-black/90 border border-subtle rounded-panel overflow-hidden flex items-center justify-center min-h-[300px] max-h-[460px] relative shadow-lg">
 {isGenerating ? (
 <div className="p-8 text-center space-y-3 z-10">
 <div className="relative w-16 h-16 mx-auto">
 <div className="absolute inset-0 rounded-full border-2 border-edge"></div>
 <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-cyan-400 animate-spin"></div>
 <Film className="absolute inset-0 m-auto text-muted w-6 h-6 animate-pulse" />
 </div>
 <div className="text-sm font-bold text-white">
 GENERATING TACTICAL VIDEO
 </div>
 <p className="text-xs text-muted max-w-sm">
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
 className={`rounded-card object-contain bg-black shadow-lg ${
 currentVideo.aspect_ratio === '9:16' ? 'max-h-[430px] aspect-[9/16]' : 'w-full max-h-[430px] aspect-[16/9]'
 }`}
 />
 </div>
 ) : (
 <div className="p-8 text-center text-muted text-xs space-y-2">
 <Film size={28} className="mx-auto text-dim mb-1" />
 <div>No video feed loaded yet.</div>
 <div className="text-[10px] text-dim">
 Choose a preset or type a prompt on the left and click Generate.
 </div>
 </div>
 )}
 </div>

 {currentVideo && (
 <div className="p-2.5 bg-surface rounded-card border border-subtle text-[11px] text-ink flex justify-between items-center gap-2">
 <div className="truncate">
 <span className="text-primary font-bold">PROMPT: </span>
 <span>"{currentVideo.prompt}"</span>
 </div>
 {currentVideo.url && (
 <a
 href={currentVideo.url}
 download={`recon-${currentVideo.id}.mp4`}
 target="_blank"
 rel="noreferrer"
 className="p-1.5 rounded-card bg-raised hover:bg-raised text-ink hover:text-white shrink-0"
 title="Download video"
 >
 <Download size={13} />
 </a>
 )}
 </div>
 )}
 </div>

 {/* RECON GALLERY */}
 <div className="space-y-2 pt-2 border-t border-subtle">
 <div className="flex justify-between items-center text-xs">
 <span className="text-muted font-bold uppercase tracking-wider flex items-center gap-1.5">
 <Layers size={13} /> Mission Video Archives
 </span>
 <span className="text-[10px] text-muted">{videoList.length} items</span>
 </div>

 <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[140px] overflow-y-auto pr-1">
 {videoList.map((item) => (
 <button
 key={item.id}
 onClick={() => setCurrentVideo(item)}
 className={`p-2 rounded-card border text-left transition-all ${
 currentVideo?.id === item.id
 ? 'bg-raised border-edge text-muted'
 : 'bg-black/40 border-subtle hover:border-edge text-muted'
 }`}
 >
 <div className="flex justify-between items-center text-[10px]">
 <span className="font-bold text-primary">{item.aspect_ratio}</span>
 <span className="text-[9px] text-muted">{item.timestamp}</span>
 </div>
 <div className="text-[10px] truncate text-ink mt-1">
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
