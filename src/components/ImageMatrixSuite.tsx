import React, { useState, useEffect, useRef } from 'react';
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
  
  // Edit mode states
  const [editPrompt, setEditPrompt] = useState(IMAGE_EDIT_PRESETS[0]);
  const [selectedSourceImage, setSelectedSourceImage] = useState<string | null>(null);
  
  // Processing states
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentImage, setCurrentImage] = useState<ImageItem | null>(null);
  const [imageList, setImageList] = useState<ImageItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch initial media gallery
  useEffect(() => {
    fetch('/api/pilot/media/gallery')
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
      const res = await fetch('/api/pilot/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: createPrompt.trim(),
          aspect_ratio: aspectRatio,
          image_size: imageSize,
        }),
      });

      const data = await res.json();
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
      const res = await fetch('/api/pilot/image/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: editPrompt.trim(),
          imageBase64: selectedSourceImage,
          mimeType: 'image/png',
        }),
      });

      const data = await res.json();
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
    <div className="flex flex-col h-full bg-[#05060A] border border-[#D4AF37]/50 rounded-lg overflow-hidden shadow-[0_0_30px_rgba(212,175,55,0.15)] relative">
      {/* HEADER */}
      <div className="bg-gradient-to-r from-[#0F1219] via-[#1A1C23] to-[#0F1219] border-b border-[#D4AF37]/30 p-3 flex flex-wrap gap-2 justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#D4AF37]/10 rounded-md border border-[#D4AF37]/50 shadow-[0_0_12px_rgba(212,175,55,0.2)]">
            <Wand2 className="text-[#F6E076] w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white tracking-widest uppercase font-mono">
                Image Matrix & Inpainting Suite
              </h2>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#D4AF37]/20 text-[#F6E076] border border-[#D4AF37]/40 font-mono font-bold">
                NANO BANANA 2.1
              </span>
            </div>
            <p className="text-[10px] text-gray-400 font-mono">
              Model: <code className="text-[#00E5FF]">gemini-nano-banana-2.1</code> · Text-to-Image & Multimodal Image Editing
            </p>
          </div>
        </div>

        {/* MODE TOGGLES */}
        <div className="flex items-center gap-2">
          <div className="flex bg-[#0c101a] p-1 rounded-lg border border-gray-800">
            <button
              onClick={() => setMode('create')}
              className={`px-3 py-1 rounded text-xs font-mono font-bold transition-all ${
                mode === 'create'
                  ? 'bg-[#D4AF37]/20 text-[#F6E076] border border-[#D4AF37]/50'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              CREATE NEW
            </button>
            <button
              onClick={() => setMode('edit')}
              className={`px-3 py-1 rounded text-xs font-mono font-bold transition-all ${
                mode === 'edit'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              EDIT / MODIFY
            </button>
          </div>

          {onJumpToCockpit && (
            <button
              onClick={onJumpToCockpit}
              className="px-2.5 py-1.5 rounded bg-[#0d1017] hover:bg-[#161d2d] border border-gray-800 text-xs font-mono text-[#F6E076] transition-colors"
            >
              ← COCKPIT
            </button>
          )}
        </div>
      </div>

      {/* WORKSPACE */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-gray-800 min-h-0">
        
        {/* LEFT / CONTROLS (5 cols) */}
        <div className="lg:col-span-5 p-4 bg-[#07090F] flex flex-col justify-between space-y-4 overflow-y-auto">
          <div className="space-y-4">
            
            {mode === 'create' ? (
              /* CREATE MODE CONTROLS */
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-mono font-bold text-gray-300">ASPECT RATIO:</label>
                    <select
                      value={aspectRatio}
                      onChange={(e) => setAspectRatio(e.target.value)}
                      className="w-full bg-[#0a0d14] border border-gray-800 rounded p-2 text-xs font-mono text-white focus:outline-none focus:border-[#D4AF37]"
                    >
                      <option value="1:1">1:1 Square</option>
                      <option value="16:9">16:9 Landscape</option>
                      <option value="9:16">9:16 Portrait</option>
                      <option value="4:3">4:3 Standard</option>
                      <option value="3:4">3:4 Vertical</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-mono font-bold text-gray-300">IMAGE SIZE:</label>
                    <select
                      value={imageSize}
                      onChange={(e) => setImageSize(e.target.value)}
                      className="w-full bg-[#0a0d14] border border-gray-800 rounded p-2 text-xs font-mono text-white focus:outline-none focus:border-[#D4AF37]"
                    >
                      <option value="1K">1K Resolution</option>
                      <option value="2K">2K High Res</option>
                      <option value="4K">4K Ultra Res</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label htmlFor="image-prompt-input" className="text-xs font-mono font-bold text-gray-300">
                      SYNTHESIS PROMPT (NANO BANANA 2.1):
                    </label>
                    <span className="text-[10px] text-gray-500 font-mono">{createPrompt.length} chars</span>
                  </div>
                  <textarea
                    id="image-prompt-input"
                    value={createPrompt}
                    onChange={(e) => setCreatePrompt(e.target.value)}
                    placeholder="Describe tactical image scene to create..."
                    disabled={isProcessing}
                    rows={4}
                    className="w-full bg-black/80 border border-gray-800 focus:border-[#D4AF37] focus:ring-1 focus:ring-[#D4AF37]/50 rounded-lg p-2.5 text-xs font-mono text-gray-200 resize-none disabled:opacity-50 transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <span className="text-[10px] text-gray-500 font-mono font-bold tracking-wider">
                    QUICK SYNTHESIS PRESETS:
                  </span>
                  <div className="space-y-1">
                    {IMAGE_CREATE_PRESETS.map((p, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setCreatePrompt(p)}
                        className="w-full text-left p-2 rounded bg-[#0c1018] hover:bg-[#141b29] border border-gray-800/80 text-[11px] font-mono text-gray-300 hover:text-white transition-colors truncate"
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
                  <label className="text-xs font-mono font-bold text-gray-300 flex justify-between items-center">
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
                      className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-[10px] text-cyan-300 flex items-center gap-1"
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
                        className={`w-14 h-14 rounded border shrink-0 overflow-hidden relative transition-all ${
                          selectedSourceImage === img.url
                            ? 'ring-2 ring-cyan-400 border-white'
                            : 'border-gray-800 opacity-60 hover:opacity-100'
                        }`}
                      >
                        <img src={img.url} alt="thumbnail" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label htmlFor="edit-prompt-input" className="text-xs font-mono font-bold text-gray-300">
                      EDITING INSTRUCTION (INPAINTING / MODIFICATION):
                    </label>
                    <span className="text-[10px] text-gray-500 font-mono">{editPrompt.length} chars</span>
                  </div>
                  <textarea
                    id="edit-prompt-input"
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    placeholder="Describe changes: 'Add cyan targeting reticles', 'Change lighting to night vision'..."
                    disabled={isProcessing}
                    rows={4}
                    className="w-full bg-black/80 border border-gray-800 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/50 rounded-lg p-2.5 text-xs font-mono text-gray-200 resize-none disabled:opacity-50 transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <span className="text-[10px] text-gray-500 font-mono font-bold tracking-wider">
                    TACTICAL MODIFICATION PRESETS:
                  </span>
                  <div className="space-y-1">
                    {IMAGE_EDIT_PRESETS.map((p, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setEditPrompt(p)}
                        className="w-full text-left p-2 rounded bg-[#0c1018] hover:bg-[#141b29] border border-gray-800/80 text-[11px] font-mono text-gray-300 hover:text-white transition-colors truncate"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {errorMsg && (
              <div className="p-2.5 bg-red-950/40 border border-red-500/60 rounded text-red-300 text-xs font-mono">
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
                className="w-full py-3.5 bg-gradient-to-r from-[#D4AF37] to-[#F6E076] text-black font-mono font-bold text-xs tracking-widest uppercase rounded-lg hover:brightness-110 active:brightness-95 transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(212,175,55,0.4)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isProcessing ? (
                  <>
                    <RefreshCw size={15} className="animate-spin" />
                    <span>SYNTHESIZING IMAGE VIA NANO BANANA 2.1...</span>
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
                className="w-full py-3.5 bg-gradient-to-r from-cyan-500 to-[#00E5FF] text-black font-mono font-bold text-xs tracking-widest uppercase rounded-lg hover:brightness-110 active:brightness-95 transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(0,229,255,0.4)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isProcessing ? (
                  <>
                    <RefreshCw size={15} className="animate-spin" />
                    <span>APPLYING MODIFICATION VIA NANO BANANA 2.1...</span>
                  </>
                ) : (
                  <>
                    <Wand2 size={15} />
                    <span>APPLY IMAGE MODIFICATION (NANO BANANA 2.1)</span>
                  </>
                )}
              </button>
            )}
            <div className="text-[9px] text-gray-500 text-center font-mono mt-1.5">
              Powered by Google GenAI Interactions API · Model gemini-nano-banana-2.1
            </div>
          </div>
        </div>

        {/* RIGHT / PREVIEW & COMPARISON (7 cols) */}
        <div className="lg:col-span-7 p-4 bg-[#05070C] flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider font-mono flex items-center gap-2">
                <Eye size={14} className="text-[#F6E076]" /> High-Resolution Asset Canvas
              </h3>
              {currentImage && (
                <span className="text-[10px] font-mono text-[#F6E076] bg-[#D4AF37]/15 px-2 py-0.5 rounded border border-[#D4AF37]/40">
                  {currentImage.type.toUpperCase()} · {currentImage.model}
                </span>
              )}
            </div>

            {/* PREVIEW CONTAINER */}
            <div className="w-full bg-black/90 border border-gray-800 rounded-xl overflow-hidden flex items-center justify-center min-h-[300px] max-h-[460px] relative p-3 shadow-[0_0_30px_rgba(0,0,0,0.8)]">
              {isProcessing ? (
                <div className="p-8 text-center space-y-3 z-10">
                  <div className="relative w-16 h-16 mx-auto">
                    <div className="absolute inset-0 rounded-full border-2 border-amber-500/20"></div>
                    <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#F6E076] animate-spin"></div>
                    <Wand2 className="absolute inset-0 m-auto text-[#F6E076] w-6 h-6 animate-pulse" />
                  </div>
                  <div className="text-sm font-bold text-white font-mono">
                    {mode === 'create' ? 'GENERATING IMAGE' : 'MODIFYING IMAGE'}
                  </div>
                  <p className="text-xs text-gray-400 max-w-sm font-mono">
                    gemini-nano-banana-2.1 computing high-resolution pixel matrices...
                  </p>
                </div>
              ) : (mode === 'edit' || currentImage?.type === 'edited-image') && (currentImage?.sourceImageUrl || selectedSourceImage) ? (
                /* SIDE-BY-SIDE BEFORE / AFTER */
                <div className="grid grid-cols-2 gap-3 w-full h-full max-h-[420px]">
                  <div className="flex flex-col items-center">
                    <span className="text-[10px] font-mono text-gray-400 mb-1">ORIGINAL SOURCE</span>
                    <img
                      src={currentImage?.sourceImageUrl || selectedSourceImage || ''}
                      alt="Source before edit"
                      className="rounded-lg object-contain max-h-[360px] bg-black/60 border border-gray-800"
                    />
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="text-[10px] font-mono text-cyan-400 font-bold mb-1">EDITED (NANO BANANA 2.1)</span>
                    <img
                      src={currentImage?.url || selectedSourceImage || ''}
                      alt="Edited result"
                      className="rounded-lg object-contain max-h-[360px] bg-black/60 border border-cyan-500/50 shadow-[0_0_15px_rgba(0,229,255,0.2)]"
                    />
                  </div>
                </div>
              ) : currentImage?.url ? (
                <div className="flex items-center justify-center w-full h-full">
                  <img
                    src={currentImage.url}
                    alt={currentImage.prompt}
                    className="rounded-lg object-contain max-h-[420px] max-w-full shadow-lg border border-gray-800"
                  />
                </div>
              ) : (
                <div className="p-8 text-center text-gray-500 font-mono text-xs space-y-2">
                  <Image size={28} className="mx-auto text-gray-600 mb-1" />
                  <div>No image asset selected.</div>
                  <div className="text-[10px] text-gray-600">
                    Use the left panel to synthesize or modify an image asset.
                  </div>
                </div>
              )}
            </div>

            {currentImage && (
              <div className="p-2.5 bg-[#0A0D15] rounded-lg border border-gray-800/80 text-[11px] font-mono text-gray-300 flex justify-between items-center gap-2">
                <div className="truncate">
                  <span className="text-[#00E5FF] font-bold">
                    {currentImage.type === 'edited-image' ? 'EDIT DIRECTIVE: ' : 'PROMPT: '}
                  </span>
                  <span>"{currentImage.prompt}"</span>
                </div>
                {currentImage.url && (
                  <a
                    href={currentImage.url}
                    download={`recon-${currentImage.id}.png`}
                    className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white shrink-0"
                    title="Download image"
                  >
                    <Download size={13} />
                  </a>
                )}
              </div>
            )}
          </div>

          {/* ASSET GALLERY */}
          <div className="space-y-2 pt-2 border-t border-gray-800">
            <div className="flex justify-between items-center text-xs font-mono">
              <span className="text-gray-400 font-bold uppercase tracking-wider flex items-center gap-1.5">
                <Layers size={13} /> Visual Reconnaissance Archives
              </span>
              <span className="text-[10px] text-gray-500">{imageList.length} items</span>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-[140px] overflow-y-auto pr-1">
              {imageList.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setCurrentImage(item);
                    setSelectedSourceImage(item.url);
                  }}
                  className={`p-1.5 rounded-lg border text-left font-mono transition-all flex items-center gap-2 ${
                    currentImage?.id === item.id
                      ? 'bg-[#D4AF37]/15 border-[#D4AF37] text-white'
                      : 'bg-black/40 border-gray-800 hover:border-gray-700 text-gray-400'
                  }`}
                >
                  <img src={item.url} alt="asset" className="w-8 h-8 rounded object-cover shrink-0" />
                  <div className="truncate text-[10px]">
                    <div className="text-[#F6E076] font-bold truncate">{item.type}</div>
                    <div className="text-gray-500 truncate">{item.timestamp}</div>
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
