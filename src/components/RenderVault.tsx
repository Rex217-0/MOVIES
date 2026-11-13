import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { PlayCircle, CheckCircle, XCircle, RefreshCw, Send, Film, ShieldCheck } from 'lucide-react';

export interface VideoAsset {
  id: string;
  title: string;
  url: string; 
  status: 'rendering' | 'completed' | 'failed';
  reviewStatus: 'pending' | 'approved' | 'rejected'; // Ito ang bago
  createdAt: string;
}

export const RenderVault: React.FC<{
  onJumpToVideoGen?: () => void;
}> = ({ onJumpToVideoGen }) => {
  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'pending' | 'approved'>('pending');

  // Fetch data from backend
  const fetchAssets = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/assets/list'); 
      if (res.ok) {
        const data = await res.json();
        setAssets(data);
      }
    } catch (error) {
      console.error("Failed to load assets", error);
 } finally {
 setIsLoading(false);
 }
 };

 // Handle Approve/Reject Actions
 const handleReviewAction = async (id: string, action: 'approve' | 'reject') => {
 try {
 // Send command to backend
 const res = await apiFetch('/api/assets/review', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ assetId: id, action })
 });

 if (res.ok) {
 // Optimistically update UI
 setAssets(prev => prev.map(asset => 
 asset.id === id 
 ? { ...asset, reviewStatus: action === 'approve' ? 'approved' : 'rejected' } 
 : asset
 ));
 } else {
 console.error("Failed to process review action. Check backend.");
 }
 } catch (error) {
 console.error("Review action failed", error);
 }
 };

 useEffect(() => {
 fetchAssets();
 const interval = setInterval(fetchAssets, 10000);
 return () => clearInterval(interval);
 }, []);

 // Filter assets based on active tab
 const filteredAssets = assets.filter(asset => {
 if (activeTab === 'pending') return asset.reviewStatus === 'pending' && asset.status === 'completed';
 return asset.reviewStatus === 'approved';
 });

 return (
 <div className="flex flex-col h-full bg-surface border border-subtle rounded-card overflow-hidden shadow-none relative">
 
 {/* HEADER & TABS */}
 <div className="flex flex-wrap gap-2 justify-between items-center p-3 border-b border-subtle bg-page-soft">
 <div className="flex gap-4">
 <button 
 onClick={() => setActiveTab('pending')}
 className={`text-sm font-bold tracking-widest flex items-center gap-2 pb-1 border-b-2 transition-colors ${
 activeTab === 'pending' ? 'text-primary border-primary' : 'text-muted border-transparent hover:text-ink'
 }`}
 >
 <PlayCircle size={16} /> STAGING (REVIEW)
 {assets.filter(a => a.reviewStatus === 'pending' && a.status === 'completed').length > 0 && (
 <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-primary-soft text-primary border border-primary font-bold">
 {assets.filter(a => a.reviewStatus === 'pending' && a.status === 'completed').length}
 </span>
 )}
 </button>
 <button 
 onClick={() => setActiveTab('approved')}
 className={`text-sm font-bold tracking-widest flex items-center gap-2 pb-1 border-b-2 transition-colors ${
 activeTab === 'approved' ? 'text-growth border-growth-soft' : 'text-muted border-transparent hover:text-ink'
 }`}
 >
 <CheckCircle size={16} /> PUBLISHED TO CINESTREAM
 {assets.filter(a => a.reviewStatus === 'approved').length > 0 && (
 <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-growth-soft text-growth border border-growth-soft font-bold">
 {assets.filter(a => a.reviewStatus === 'approved').length}
 </span>
 )}
 </button>
 </div>
 
 <div className="flex items-center gap-2">
 {onJumpToVideoGen && (
 <button
 onClick={onJumpToVideoGen}
 className="px-2.5 py-1 rounded-card bg-raised hover:bg-raised border border-edge text-xs text-muted flex items-center gap-1.5 transition-colors"
 >
 <Film size={12} /> RENDER NEW (OMNI FLASH)
 </button>
 )}

 <button 
 onClick={fetchAssets} 
 title="Refresh assets list"
 aria-label="Refresh video assets"
 className="p-1.5 text-muted hover:text-white transition-colors rounded-card hover:bg-raised"
 >
 <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
 </button>
 </div>
 </div>

 {/* VIDEO GRID */}
 <div className="flex-1 p-4 overflow-y-auto min-h-0">
 {filteredAssets.length === 0 && !isLoading ? (
 <div className="flex flex-col items-center justify-center h-full text-muted text-xs p-8 text-center space-y-2">
 <PlayCircle size={36} className="mb-1 opacity-40 text-muted" />
 <p className="text-sm font-bold text-muted">Walang laman ang {activeTab === 'pending' ? 'Staging Area' : 'Published Vault'}.</p>
 <p className="text-[11px] text-muted max-w-sm">
 {activeTab === 'pending' 
 ? 'Mag-antay ng bagong render mula sa SERVER-2 o mag-generate sa Video Recon suite.' 
 : 'Mag-approve ng video sa Staging tab para lumabas sa live Cinestream.'}
 </p>
 {onJumpToVideoGen && (
 <button
 onClick={onJumpToVideoGen}
 className="mt-3 px-3 py-1.5 bg-primary hover:bg-primary-hover rounded-card text-xs text-primary-ink font-bold"
 >
 RENDER VIDEO NOW
 </button>
 )}
 </div>
 ) : (
 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 {filteredAssets.map((asset) => (
 <div key={asset.id} className="bg-page-soft border border-subtle rounded-card overflow-hidden group hover:border-edge transition-all shadow-md">
 
 {/* Video Player */}
 <div className="aspect-video bg-black relative flex items-center justify-center">
 <video 
 src={asset.url} 
 controls 
 className="w-full h-full object-cover"
 />
 <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-card text-[9px] font-bold uppercase tracking-wider bg-black/70 backdrop-blur-sm border border-edge text-ink">
 {asset.status}
 </div>
 </div>
 
 {/* Meta & Actions */}
 <div className="p-3">
 <h3 className="text-xs font-bold text-white truncate">{asset.title}</h3>
 <p className="text-[10px] text-muted mt-1">{new Date(asset.createdAt).toLocaleString()}</p>
 
 {/* ACTION BUTTONS */}
 <div className="flex gap-2 mt-3">
 {activeTab === 'pending' ? (
 <>
 <button 
 onClick={() => handleReviewAction(asset.id, 'approve')}
 className="flex-1 py-1.5 bg-growth-soft text-growth border border-growth-soft text-[10px] font-bold rounded-card flex items-center justify-center gap-1 hover:brightness-110 transition-all shadow-none"
 >
 <CheckCircle size={12} /> APPROVE & PUBLISH
 </button>
 <button 
 onClick={() => handleReviewAction(asset.id, 'reject')}
 className="flex-1 py-1.5 bg-red-500/10 text-red-300 border border-red-500/40 text-[10px] font-bold rounded-card flex items-center justify-center gap-1 hover:bg-red-500/10 transition-colors"
 >
 <XCircle size={12} /> REJECT
 </button>
 </>
 ) : (
 <a 
 href={asset.url} 
 target="_blank" 
 rel="noreferrer"
 className="w-full py-1.5 bg-primary text-primary-ink text-[10px] font-bold rounded-card flex items-center justify-center gap-1 hover:bg-primary-hover transition-colors shadow-none"
                      >
                        <Send size={12} /> VIEW LIVE ON CINESTREAM
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default RenderVault;
