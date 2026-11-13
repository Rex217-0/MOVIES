import React, { useState, useEffect, useRef } from 'react';
import { apiFetch, direkLoraList, type LoraFile } from '../api';
import { 
  Image, Wand2, Sparkles, Upload, Download, 
  RefreshCw, Check, ArrowRight, Layers, Sliders, Eye
} from 'lucide-react';

interface ImageItem {
  id: string;
  type: string;
  url: string;
  prompt: string;
  aspect_ratio: string;
  timestamp: string;
  model: string;
  sourceImageUrl?: string;
  details?: string;
}

const IMAGE_CREATE_PRESETS = [
  'Tactical holographic wireframe of deep-space combat cruiser with cybernetic HUD reticles',
  'First-person view inside VIP stealth cockpit with glowing amber HUD instruments, starfield ahead',
  'Orbital defense array firing pinpoint particle lasers at incoming hyper-velocity debris',
  'Cybernetic pilot tactical neural helmet with glowing cyan visor reflection and carbon weave',
];

const IMAGE_EDIT_PRESETS = [
  'Add glowing cyan holographic targeting reticles and telemetry lock vectors over the center',
  'Convert to high-contrast infrared thermal spectrum scan with heat signatures highlighted in amber',
  'Apply heavy battle damage, hull scorch marks, and electrical plasma discharge sparks',
  'Overlay night-vision tactical reconnaissance scanlines and green sensor data brackets',
];

export const ImageMatrixSuite: React.FC<{
  onJumpToCockpit?: () => void;
}> = ({ onJumpToCockpit }) => {
  const [mode, setMode] = useState<'create' | 'edit'>('create');
  const [createPrompt, setCreatePrompt] = useState(IMAGE_CREATE_PRESETS[0]);
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [imageSize, setImageSize] = useState('1K');
  const [loras, setLoras] = useState<LoraFile[]>([]);
  const [useLora, setUseLora] = useState('');
  const [loraStrength, setLoraStrength] = useState(1);
  
  // Edit mode states
  const [editPrompt, setEditPrompt] = useState(IMAGE_EDIT_PRESETS[0]);
  const [selectedSourceImage, setSelectedSourceImage] = useState<string | null>(null);
  
  // Processing states
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentImage, setCurrentImage] = useState<ImageItem | null>(null);
  const [imageList, setImageList] = useState<ImageItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch the trained LoRAs that ComfyUI can load.
  useEffect(() => {
    direkLoraList().then(r => setLoras(r.loras)).catch(() => {});
  }, []);

  // Fetch initial media gallery
  useEffect(() => {
    apiFetch('/api/pilot/media/gallery')
      .then(res => res.json())
      .then(data => {
        if (data.items) {
          const imgs = data.items.filter((i: any) => i.type === 'image' || i.type === 'edited-image');
          setImageList(imgs);
          if (imgs.length > 0 && !currentImage) {
            setCurrentImage(imgs[0]);
            setSelectedSourceImage(imgs[0].url);
          }
        }
      })
      .catch(() => {});
  }, []);

  // Handle local file upload for editing
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      setSelectedSourceImage(base64);
      setMode('edit');
    };
    reader.readAsDataURL(file);
  };

  // Generate new image
  const handleCreateImage = async () => {
    if (!createPrompt.trim() || isProcessing) return;

    setIsProcessing(true);
    setErrorMsg(null);

    try {
      const res = await apiFetch('/api/pilot/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: createPrompt.trim(),
          aspect_ratio: aspectRatio,
          image_size: imageSize,
          lora: useLora || undefined,
          loraStrength: useLora ? loraStrength : undefined,
        }),
      });

      const data = await res.json();
      if (res.status === 503) throw new Error(data.error || 'Image generation is unavailable.');
      if (!res.ok || data.error) throw new Error(data.error || 'Image generation failed');

      if (data.item) {
        setCurrentImage(data.item);
        setSelectedSourceImage(data.item.url);
        setImageList(prev => [data.item, ...prev.filter(i => i.id !== data.item.id)]);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Image generation error');
    } finally {
      setIsProcessing(false);
    }
  };

  // Edit image
  const handleEditImage = async () => {
    if (!selectedSourceImage || !editPrompt.trim() || isProcessing) return;

    setIsProcessing(true);
    setErrorMsg(null);

    try {
      const res = await apiFetch('/api/pilot/image/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: editPrompt.trim(),
          imageBase64: selectedSourceImage,
          mimeType: 'image/png',
        }),
      });

      const data = await res.json();
      if (res.status === 503) throw new Error(data.error || 'Image editing is unavailable.');
      if (!res.ok || data.error) throw new Error(data.error || 'Image editing failed');

      if (data.item) {
        setCurrentImage(data.item);
        setImageList(prev => [data.item, ...prev.filter(i => i.id !== data.item.id)]);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Image modification error');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-sunken border border-primary rounded-card overflow-hidden shadow-none relative">
 {/* HEADER */}
 <div className="bg-page-soft border-b border-primary p-3 flex flex-wrap gap-2 justify-between items-center">
 <div className="flex items-center gap-3">
 <div className="p-2 bg-primary rounded-md shadow-none">
 <Wand2 className="text-primary w-5 h-5 animate-pulse" />
 </div>
 <div>
 <div className="flex items-center gap-2">
 <h2 className="text-sm font-bold text-white tracking-widest uppercase">
 Image Matrix & Inpainting Suite
 </h2>
 <span className="text-[9px] px-1.5 py-0.5 rounded-card bg-primary text-primary-ink font-bold">
 IMAGE MATRIX
 </span>
 </div>
 <p className="text-[10px] text-muted">
 Backend: <code className="text-muted">ComfyUI (local, free)</code> · fallback gemini-2.5-flash-image (paid)
 </p>
 </div>
 </div>

 {/* MODE TOGGLES */}
 <div className="flex items-center gap-2">
 <div className="flex bg-surface p-1 rounded-card border border-subtle">
 <button
 onClick={() => setMode('create')}
 className={`px-3 py-1 rounded-card text-xs font-bold transition-all ${
 mode === 'create'
 ? 'bg-primary text-primary-ink'
 : 'text-muted hover:text-white'
 }`}
 >
 CREATE NEW
 </button>
 <button
 onClick={() => setMode('edit')}
 className={`px-3 py-1 rounded-card text-xs font-bold transition-all ${
 mode === 'edit'
 ? 'bg-raised text-muted border border-edge'
 : 'text-muted hover:text-white'
 }`}
 >
 EDIT / MODIFY
 </button>
 </div>

 {onJumpToCockpit && (
 <button
 onClick={onJumpToCockpit}
 className="px-2.5 py-1.5 rounded-card bg-surface hover:bg-raised border border-subtle text-xs text-primary transition-colors"
 >
 ← COCKPIT
 </button>
 )}
 </div>
 </div>

 {/* WORKSPACE */}
 <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-gray-800 min-h-0">
 
 {/* LEFT / CONTROLS (5 cols) */}
 <div className="lg:col-span-5 p-4 bg-sunken flex flex-col justify-between space-y-4 overflow-y-auto">
 <div className="space-y-4">
 
 {mode === 'create' ? (
 /* CREATE MODE CONTROLS */
 <>
 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-xs font-bold text-ink">ASPECT RATIO:</label>
 <select
 value={aspectRatio}
 onChange={(e) => setAspectRatio(e.target.value)}
 className="w-full bg-surface border border-subtle rounded-card p-2 text-xs text-white focus:outline-none focus:border-primary"
 >
 <option value="1:1">1:1 Square</option>
 <option value="16:9">16:9 Landscape</option>
 <option value="9:16">9:16 Portrait</option>
 <option value="4:3">4:3 Standard</option>
 <option value="3:4">3:4 Vertical</option>
 </select>
 </div>

 <div className="space-y-1">
 <label className="text-xs font-bold text-ink">IMAGE SIZE:</label>
 <select
 value={imageSize}
 onChange={(e) => setImageSize(e.target.value)}
 className="w-full bg-surface border border-subtle rounded-card p-2 text-xs text-white focus:outline-none focus:border-primary"
 >
 <option value="1K">1K Resolution</option>
 <option value="2K">2K High Res</option>
 <option value="4K">4K Ultra Res</option>
 </select>
 </div>
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1">
 <label className="text-xs font-bold text-ink">TRAINED LORA:</label>
 <select
 value={useLora}
 onChange={(e) => setUseLora(e.target.value)}
 className="w-full bg-surface border border-subtle rounded-card p-2 text-xs text-white focus:outline-none focus:border-primary"
 >
 <option value="">(base model only)</option>
 {loras.map(l => (
 <option key={l.name} value={l.name}>{l.name}</option>
 ))}
 </select>
 </div>
 <div className="space-y-1">
 <label className="text-xs font-bold text-ink">
 LORA STRENGTH: {loraStrength.toFixed(2)}
 </label>
 <input
 type="range" min={0} max={2} step={0.05} value={loraStrength}
 onChange={(e) => setLoraStrength(Number(e.target.value))}
 disabled={!useLora}
 className="w-full accent-[#F6E076] disabled:opacity-40"
 />
 </div>
 </div>

 <div className="space-y-1.5">
 <div className="flex justify-between items-center">
 <label htmlFor="image-prompt-input" className="text-xs font-bold text-ink">
 SYNTHESIS PROMPT:
 </label>
 <span className="text-[10px] text-muted">{createPrompt.length} chars</span>
 </div>
 <textarea
 id="image-prompt-input"
 value={createPrompt}
 onChange={(e) => setCreatePrompt(e.target.value)}
 placeholder="Describe tactical image scene to create..."
 disabled={isProcessing}
 rows={4}
 className="w-full bg-black/80 border border-subtle focus:border-primary focus:ring-1 focus:ring-primary rounded-card p-2.5 text-xs text-ink resize-none disabled:opacity-50 transition-colors"
 />
 </div>

 <div className="space-y-1.5">
 <span className="text-[10px] text-muted font-bold tracking-wider">
 QUICK SYNTHESIS PRESETS:
 </span>
 <div className="space-y-1">
 {IMAGE_CREATE_PRESETS.map((p, idx) => (
 <button
 key={idx}
 type="button"
 onClick={() => setCreatePrompt(p)}
 className="w-full text-left p-2 rounded-card bg-surface hover:bg-raised border border-subtle text-[11px] text-ink hover:text-white transition-colors truncate"
 >
 {p}
 </button>
 ))}
 </div>
 </div>
 </>
 ) : (
 /* EDIT MODE CONTROLS */
 <>
 <div className="space-y-2">
 <label className="text-xs font-bold text-ink flex justify-between items-center">
 <span>SOURCE IMAGE TO EDIT:</span>
 <input
 ref={fileInputRef}
 type="file"
 accept="image/*"
 onChange={handleFileUpload}
 className="hidden"
 />
 <button
 type="button"
 onClick={() => fileInputRef.current?.click()}
 className="px-2 py-0.5 rounded-card bg-raised hover:bg-raised text-[10px] text-muted flex items-center gap-1"
 >
 <Upload size={11} /> UPLOAD FILE
 </button>
 </label>

 {/* Thumbnail Selector */}
 <div className="flex gap-2 overflow-x-auto pb-1 max-h-[80px]">
 {imageList.map((img) => (
 <button
 key={img.id}
 type="button"
 onClick={() => setSelectedSourceImage(img.url)}
 className={`w-14 h-14 rounded-card border shrink-0 overflow-hidden relative transition-all ${
 selectedSourceImage === img.url
 ? 'ring-2 ring-edge border-white'
 : 'border-subtle opacity-60 hover:opacity-100'
 }`}
 >
 <img src={img.url} alt="thumbnail" className="w-full h-full object-cover" />
 </button>
 ))}
 </div>
 </div>

 <div className="space-y-1.5">
 <div className="flex justify-between items-center">
 <label htmlFor="edit-prompt-input" className="text-xs font-bold text-ink">
 EDITING INSTRUCTION (INPAINTING / MODIFICATION):
 </label>
 <span className="text-[10px] text-muted">{editPrompt.length} chars</span>
 </div>
 <textarea
 id="edit-prompt-input"
 value={editPrompt}
 onChange={(e) => setEditPrompt(e.target.value)}
 placeholder="Describe changes: 'Add cyan targeting reticles', 'Change lighting to night vision'..."
 disabled={isProcessing}
 rows={4}
 className="w-full bg-black/80 border border-subtle focus:border-edge focus:ring-1 focus:ring-edge rounded-card p-2.5 text-xs text-ink resize-none disabled:opacity-50 transition-colors"
 />
 </div>

 <div className="space-y-1.5">
 <span className="text-[10px] text-muted font-bold tracking-wider">
 TACTICAL MODIFICATION PRESETS:
 </span>
 <div className="space-y-1">
 {IMAGE_EDIT_PRESETS.map((p, idx) => (
 <button
 key={idx}
 type="button"
 onClick={() => setEditPrompt(p)}
 className="w-full text-left p-2 rounded-card bg-surface hover:bg-raised border border-subtle text-[11px] text-ink hover:text-white transition-colors truncate"
 >
 {p}
 </button>
 ))}
 </div>
 </div>
 </>
 )}

 {errorMsg && (
 <div className="p-2.5 bg-red-500/10 border border-red-500/40/40 rounded-card text-red-300 text-xs">
 {errorMsg}
 </div>
 )}
 </div>

 {/* ACTION BUTTON */}
 <div className="pt-2">
 {mode === 'create' ? (
 <button
 type="button"
 onClick={handleCreateImage}
 disabled={isProcessing || !createPrompt.trim()}
 className="w-full py-3.5 bg-primary text-primary-ink font-bold text-xs tracking-widest uppercase rounded-card hover:brightness-110 active:brightness-95 transition-all flex items-center justify-center gap-2 shadow-none disabled:opacity-40 disabled:cursor-not-allowed"
 >
 {isProcessing ? (
 <>
 <RefreshCw size={15} className="animate-spin" />
 <span>SYNTHESIZING IMAGE...</span>
 </>
 ) : (
 <>
 <Sparkles size={15} />
 <span>SYNTHESIZE IMAGE (GEMINI-NANO-BANANA-2.1)</span>
 </>
 )}
 </button>
 ) : (
 <button
 type="button"
 onClick={handleEditImage}
 disabled={isProcessing || !selectedSourceImage || !editPrompt.trim()}
 className="btn-primary flex w-full items-center justify-center gap-2 py-3.5 text-xs font-bold uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-40"
 >
 {isProcessing ? (
 <>
 <RefreshCw size={15} className="animate-spin" />
 <span>APPLYING MODIFICATION...</span>
 </>
 ) : (
 <>
 <Wand2 size={15} />
 <span>APPLY IMAGE MODIFICATION</span>
 </>
 )}
 </button>
 )}
 <div className="text-[9px] text-muted text-center mt-1.5">
 Free via local ComfyUI. Without ComfyUI this needs a paid Gemini tier.
 </div>
 </div>
 </div>

 {/* RIGHT / PREVIEW & COMPARISON (7 cols) */}
 <div className="lg:col-span-7 p-4 bg-sunken flex flex-col justify-between space-y-4">
 <div className="space-y-3">
 <div className="flex justify-between items-center">
 <h3 className="text-xs font-bold text-ink uppercase tracking-wider flex items-center gap-2">
 <Eye size={14} className="text-primary" /> High-Resolution Asset Canvas
 </h3>
 {currentImage && (
 <span className="text-[10px] text-primary-ink bg-primary px-2 py-0.5 rounded-card">
 {currentImage.type.toUpperCase()} · {currentImage.model}
 </span>
 )}
 </div>

 {/* PREVIEW CONTAINER */}
 <div className="w-full bg-black/90 border border-subtle rounded-panel overflow-hidden flex items-center justify-center min-h-[300px] max-h-[460px] relative p-3 shadow-lg">
 {isProcessing ? (
 <div className="p-8 text-center space-y-3 z-10">
 <div className="relative w-16 h-16 mx-auto">
 <div className="absolute inset-0 rounded-full border-2 border-primary"></div>
 <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#F6E076] animate-spin"></div>
 <Wand2 className="absolute inset-0 m-auto text-primary w-6 h-6 animate-pulse" />
 </div>
 <div className="text-sm font-bold text-white">
 {mode === 'create' ? 'GENERATING IMAGE' : 'MODIFYING IMAGE'}
 </div>
 <p className="text-xs text-muted max-w-sm">
 Computing high-resolution pixel matrices...
 </p>
 </div>
 ) : (mode === 'edit' || currentImage?.type === 'edited-image') && (currentImage?.sourceImageUrl || selectedSourceImage) ? (
 /* SIDE-BY-SIDE BEFORE / AFTER */
 <div className="grid grid-cols-2 gap-3 w-full h-full max-h-[420px]">
 <div className="flex flex-col items-center">
 <span className="text-[10px] text-muted mb-1">ORIGINAL SOURCE</span>
 <img
 src={currentImage?.sourceImageUrl || selectedSourceImage || ''}
 alt="Source before edit"
 className="rounded-card object-contain max-h-[360px] bg-black/60 border border-subtle"
 />
 </div>
 <div className="flex flex-col items-center">
 <span className="text-[10px] text-muted font-bold mb-1">EDITED</span>
 <img
 src={currentImage?.url || selectedSourceImage || ''}
 alt="Edited result"
 className="rounded-card object-contain max-h-[360px] bg-black/60 border border-edge shadow-none"
 />
 </div>
 </div>
 ) : currentImage?.url ? (
 <div className="flex items-center justify-center w-full h-full">
 <img
 src={currentImage.url}
 alt={currentImage.prompt}
 className="rounded-card object-contain max-h-[420px] max-w-full shadow-lg border border-subtle"
 />
 </div>
 ) : (
 <div className="p-8 text-center text-muted text-xs space-y-2">
 <Image size={28} className="mx-auto text-dim mb-1" />
 <div>No image asset selected.</div>
 <div className="text-[10px] text-dim">
 Use the left panel to synthesize or modify an image asset.
 </div>
 </div>
 )}
 </div>

 {currentImage && (
 <div className="p-2.5 bg-surface rounded-card border border-subtle text-[11px] text-ink flex justify-between items-center gap-2">
 <div className="truncate">
 <span className="text-muted font-bold">
 {currentImage.type === 'edited-image' ? 'EDIT DIRECTIVE: ' : 'PROMPT: '}
 </span>
 <span>"{currentImage.prompt}"</span>
 </div>
 {currentImage.url && (
 <a
 href={currentImage.url}
 download={`recon-${currentImage.id}.png`}
 className="p-1.5 rounded-card bg-raised hover:bg-raised text-ink hover:text-white shrink-0"
 title="Download image"
 >
 <Download size={13} />
 </a>
 )}
 </div>
 )}
 </div>

 {/* ASSET GALLERY */}
 <div className="space-y-2 pt-2 border-t border-subtle">
 <div className="flex justify-between items-center text-xs">
 <span className="text-muted font-bold uppercase tracking-wider flex items-center gap-1.5">
 <Layers size={13} /> Visual Reconnaissance Archives
 </span>
 <span className="text-[10px] text-muted">{imageList.length} items</span>
 </div>

 <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-[140px] overflow-y-auto pr-1">
 {imageList.map((item) => (
 <button
 key={item.id}
 onClick={() => {
 setCurrentImage(item);
 setSelectedSourceImage(item.url);
 }}
 className={`p-1.5 rounded-card border text-left transition-all flex items-center gap-2 ${
 currentImage?.id === item.id
 ? 'bg-primary text-primary-ink'
 : 'bg-black/40 border-subtle hover:border-edge text-muted'
 }`}
 >
 <img src={item.url} alt="asset" className="w-8 h-8 rounded-card object-cover shrink-0" />
 <div className="truncate text-[10px]">
 <div className="text-primary font-bold truncate">{item.type}</div>
 <div className="text-muted truncate">{item.timestamp}</div>
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
