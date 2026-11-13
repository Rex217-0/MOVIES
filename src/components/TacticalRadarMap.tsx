import React, { useState, useEffect } from 'react';
import { Crosshair, Shield, Radio, AlertCircle, Compass } from 'lucide-react';

interface Contact {
  id: string;
  name: string;
  type: 'friendly' | 'hostile' | 'neutral' | 'anomaly';
  x: number; // percentage
  y: number; // percentage
  distance_km: number;
  bearing: number;
}

const INITIAL_CONTACTS: Contact[] = [
  { id: 'C-01', name: 'Orbital Station Alpha', type: 'friendly', x: 28, y: 35, distance_km: 1420, bearing: 312 },
  { id: 'C-02', name: 'Unidentified Frigate', type: 'anomaly', x: 72, y: 25, distance_km: 3840, bearing: 48 },
  { id: 'C-03', name: 'Asteroid Cluster 9', type: 'neutral', x: 80, y: 78, distance_km: 2150, bearing: 135 },
  { id: 'C-04', name: 'SafeMed Beacon Echo', type: 'friendly', x: 22, y: 70, distance_km: 980, bearing: 225 },
];

export const TacticalRadarMap: React.FC = () => {
  const [contacts, setContacts] = useState<Contact[]>(INITIAL_CONTACTS);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(INITIAL_CONTACTS[1]);
  const [sweepAngle, setSweepAngle] = useState(0);

  // Sweep rotation animation
  useEffect(() => {
    const interval = setInterval(() => {
      setSweepAngle((prev) => (prev + 3) % 360);
    }, 40);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col h-full bg-[#05060A] border border-[#D4AF37]/50 rounded-lg overflow-hidden shadow-[0_0_30px_rgba(212,175,55,0.15)] relative">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#0F1219] via-[#1A1C23] to-[#0F1219] border-b border-[#D4AF37]/30 p-3 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <Radio className="text-[#00E5FF] w-4 h-4 animate-pulse" />
          <h2 className="text-xs font-bold text-white tracking-widest uppercase">
            Holographic Tactical Radar · Sector 7-Delta
          </h2>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono text-gray-400">
          <span className="flex items-center gap-1"><Compass size={12} className="text-[#F6E076]" /> BEARING: {sweepAngle}°</span>
          <span className="text-green-400">LIDAR: ACTIVE</span>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-gray-800">
        
        {/* RADAR CANVAS DISPLAY */}
        <div className="md:col-span-2 relative p-4 flex items-center justify-center bg-[#07090E] min-h-[340px] overflow-hidden">
          {/* Grid Background */}
          <div className="absolute inset-0 bg-[linear-gradient(rgba(0,229,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,229,255,0.03)_1px,transparent_1px)] bg-[size:25px_25px]"></div>

          {/* Radar Circles */}
          <div className="relative w-72 h-72 rounded-full border border-cyan-500/30 flex items-center justify-center shadow-[0_0_30px_rgba(0,229,255,0.05)]">
            <div className="absolute w-56 h-56 rounded-full border border-cyan-500/20"></div>
            <div className="absolute w-40 h-40 rounded-full border border-cyan-500/20"></div>
            <div className="absolute w-24 h-24 rounded-full border border-cyan-500/25"></div>
            <div className="absolute w-8 h-8 rounded-full border border-[#D4AF37]/50 bg-[#D4AF37]/10 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-[#F6E076]"></div>
            </div>

            {/* Crosshairs */}
            <div className="absolute w-full h-[1px] bg-cyan-500/20"></div>
            <div className="absolute h-full w-[1px] bg-cyan-500/20"></div>

            {/* Radar Sweep Ray */}
            <div
              className="absolute w-36 h-36 top-0 right-0 origin-bottom-left pointer-events-none"
              style={{
                transform: `rotate(${sweepAngle}deg)`,
                background: 'conic-gradient(from 180deg at 0% 100%, rgba(0, 229, 255, 0.25) 0deg, transparent 45deg)',
              }}
            ></div>

            {/* Contacts Plotted */}
            {contacts.map((c) => {
              const isSelected = selectedContact?.id === c.id;
              const colorClass = 
                c.type === 'friendly' ? 'bg-green-400 border-green-300 shadow-[0_0_8px_rgba(74,222,128,0.8)]' :
                c.type === 'hostile' ? 'bg-red-500 border-red-400 shadow-[0_0_8px_rgba(239,68,68,0.8)]' :
                c.type === 'anomaly' ? 'bg-[#F6E076] border-yellow-300 shadow-[0_0_8px_rgba(246,224,118,0.8)]' :
                'bg-gray-400 border-gray-300';

              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedContact(c)}
                  className={`absolute w-3.5 h-3.5 rounded-full border transform -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-transform hover:scale-150 ${colorClass} ${isSelected ? 'ring-2 ring-white scale-125' : ''}`}
                  style={{ left: `${c.x}%`, top: `${c.y}%` }}
                  title={`${c.name} (${c.type.toUpperCase()})`}
                  aria-label={`Contact ${c.name}`}
                />
              );
            })}
          </div>

          <div className="absolute bottom-3 left-3 text-[10px] font-mono text-gray-500">
            RANGE: 5,000 KM · AZIMUTH ZERO ALIGNED
          </div>
        </div>

        {/* CONTACT INSPECTOR & TELEMETRY */}
        <div className="p-4 bg-[#080B12] flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <h3 className="text-xs font-bold text-gray-300 tracking-wider uppercase flex items-center gap-2">
              <Crosshair size={14} className="text-[#00E5FF]" /> Telemetry & Target Vector
            </h3>

            {selectedContact ? (
              <div className="p-3 bg-[#0F131E] rounded-lg border border-gray-800 space-y-2.5 font-mono text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-white font-bold">{selectedContact.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${
                    selectedContact.type === 'friendly' ? 'bg-green-950 text-green-400 border border-green-800' :
                    selectedContact.type === 'anomaly' ? 'bg-amber-950 text-[#F6E076] border border-amber-800' :
                    'bg-gray-800 text-gray-300'
                  }`}>
                    {selectedContact.type}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px] pt-1 border-t border-gray-800 text-gray-400">
                  <div>
                    <span className="block text-gray-600">DISTANCE</span>
                    <span className="text-white font-bold">{selectedContact.distance_km} km</span>
                  </div>
                  <div>
                    <span className="block text-gray-600">BEARING</span>
                    <span className="text-white font-bold">{selectedContact.bearing}°</span>
                  </div>
                  <div>
                    <span className="block text-gray-600">VECTOR</span>
                    <span className="text-cyan-400">STATIONARY</span>
                  </div>
                  <div>
                    <span className="block text-gray-600">IFF CODE</span>
                    <span className="text-amber-400">{selectedContact.id}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-gray-500 text-xs font-mono">Select a blip on radar to inspect.</div>
            )}

            {/* Quick Tactical Command from Radar */}
            <div className="space-y-2">
              <div className="text-[10px] text-gray-500 font-mono">RADAR LOCK DIRECTIVE</div>
              <button
                onClick={() => {
                  if (selectedContact) {
                    const event = new CustomEvent('tactical-preset', {
                      detail: `Target lock on ${selectedContact.name} (${selectedContact.id}) at bearing ${selectedContact.bearing} deg. Calculate trajectory.`,
                    });
                    window.dispatchEvent(event);
                  }
                }}
                className="w-full py-2 bg-[#171D2B] hover:bg-[#20293D] border border-cyan-500/40 text-cyan-300 text-xs font-mono font-bold rounded transition-colors flex items-center justify-center gap-2"
              >
                <Crosshair size={13} /> LOCK TARGET VECTOR
              </button>
            </div>
          </div>

          <div className="p-2.5 bg-black/40 rounded border border-gray-800 text-[10px] text-gray-400 font-mono flex items-center gap-2">
            <Shield size={14} className="text-green-400 shrink-0" />
            <span>Moccasin signature dampener active: ship blip masked from hostile sensors.</span>
          </div>
        </div>
      </div>
    </div>
  );
};
