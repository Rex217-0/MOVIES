import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Radio, RefreshCw, Crosshair, ShieldCheck, AlertTriangle, Power, Activity,
  Cpu, Cloud, Database, GraduationCap, Bot, Film,
} from 'lucide-react';
import { direkSystemMap, type MapNode, type NodeStatus, type SystemMap } from '../api';

/**
 * The Radar is a live system map, not a decoration. Movie Creator sits in the
 * middle; the providers that feed it are placed behind, left, right and in
 * front, connected by wires coloured from each provider's own logo. Every dot
 * blinks according to a real probe: green pulses smoothly when a service
 * answered, red blinks hard on a failure, amber breathes when a provider is
 * configured but not verified, and black sits still when nothing is there.
 */

const VIEW = 720;            // square viewBox for the map
const C = VIEW / 2;          // centre
const RING = { behind: 150, left: 205, right: 205, front: 275 };

interface Placed extends MapNode {
  x: number;
  y: number;
  /** angle from the centre, in degrees */
  angle: number;
}

const KIND_ICON: Record<MapNode['kind'], React.ComponentType<{ size?: number; className?: string }>> = {
  core: Film, ai: Bot, local: Cpu, cloud: Cloud,
  storage: Database, training: GraduationCap, agent: ShieldCheck,
};

const STATUS_COLOR: Record<NodeStatus, string> = {
  active: '#54f893',   // green
  error: '#ff4d4d',    // red
  standby: '#ffc233',  // amber
  dead: '#3a3a3a',     // near-black
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  active: 'Buhay at verified',
  error: 'May error',
  standby: 'Naka-configure, hindi pa verified',
  dead: 'Patay / wala',
};

/** Place each node on its layer's arc so nodes never overlap. */
function placeNodes(nodes: MapNode[]): Placed[] {
  const groups: Record<string, MapNode[]> = { behind: [], left: [], right: [], front: [] };
  for (const n of nodes) if (n.layer !== 'center') groups[n.layer].push(n);

  const placed: Placed[] = [];
  // Angles are degrees clockwise from the top (12 o'clock): behind spans the
  // top arc, left the left side, right the right side, front the bottom arc.
  const arcs: Record<string, [number, number]> = {
    behind: [210, 330],
    left: [110, 190],
    right: [350, 70],
    front: [30, 150],
  };
  for (const layer of ['behind', 'left', 'right', 'front'] as const) {
    const list = groups[layer];
    if (!list.length) continue;
    const [a0, a1] = arcs[layer];
    const span = (a1 - a0 + 360) % 360 || 1;
    list.forEach((n, i) => {
      const t = list.length === 1 ? 0.5 : i / (list.length - 1);
      const angle = (a0 + span * t) % 360;
      const rad = (angle * Math.PI) / 180;
      const r = RING[layer];
      placed.push({ ...n, angle, x: C + r * Math.sin(rad), y: C - r * Math.cos(rad) });
    });
  }
  return placed;
}

export const TacticalRadarMap: React.FC = () => {
  const [map, setMap] = useState<SystemMap | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>('movie-creator');
  const [auto, setAuto] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await direkSystemMap();
      if (!data) { setError('Hindi maabot ang system map endpoint.'); return; }
      setMap(data);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Nabigo ang pag-load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!auto) { if (timer.current) clearInterval(timer.current); return; }
    timer.current = setInterval(() => { void load(); }, 20000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [auto, load]);

  const placed = useMemo(() => (map ? placeNodes(map.nodes) : []), [map]);
  const centerNode = map?.nodes.find(n => n.layer === 'center');
  const selectedNode = placed.find(n => n.id === selected) ?? centerNode;

  const counts = map?.counts ?? { active: 0, error: 0, standby: 0, dead: 0 };

  return (
    <div className="flex flex-col h-full bg-sunken border border-subtle rounded-card overflow-hidden">
      {/* header */}
      <div className="bg-page-soft border-b border-subtle p-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Radio className="text-growth w-4 h-4" />
          <h2 className="text-xs font-bold text-ink tracking-widest uppercase">
            Live System Radar · sino ang nagbibigay ng power
          </h2>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted">
          {(['active', 'error', 'standby', 'dead'] as NodeStatus[]).map(s => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="radar-dot" style={{ width: 8, height: 8, background: STATUS_COLOR[s] }} />
              {counts[s]} {s}
            </span>
          ))}
          <button
            onClick={() => setAuto(a => !a)}
            className={`btn-ghost px-2 py-1 text-[10px] flex items-center gap-1 ${auto ? 'text-growth' : 'text-dim'}`}
            title="Auto-refresh tuwing 20s"
          >
            <Activity size={11} /> {auto ? 'LIVE' : 'PAUSED'}
          </button>
          <button onClick={() => void load()} className="btn-ghost px-2 py-1 text-[10px] flex items-center gap-1">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 grid lg:grid-cols-[1fr_320px] min-h-0">
        {/* the map */}
        <div className="relative flex items-center justify-center p-2 min-h-[420px]">
          <svg viewBox={`0 0 ${VIEW} ${VIEW}`} className="w-full h-full max-h-[70vh]">
            <defs>
              <radialGradient id="radar-bg" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#0d1a12" />
                <stop offset="100%" stopColor="#050505" />
              </radialGradient>
              <filter id="radar-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            <rect x="0" y="0" width={VIEW} height={VIEW} fill="url(#radar-bg)" />

            {/* rings */}
            {[RING.behind, RING.left, RING.front].map((r, i) => (
              <circle key={i} cx={C} cy={C} r={r} fill="none"
                stroke="#1f3a2a" strokeWidth="1" strokeDasharray="3 6" />
            ))}
            <circle cx={C} cy={C} r={RING.front + 22} fill="none" stroke="#16241c" strokeWidth="1" />

            {/* sweeping beam */}
            <g className="radar-sweep" opacity="0.5">
              <line x1={C} y1={C} x2={C} y2={C - RING.front - 22}
                stroke="#54f893" strokeWidth="1.5" opacity="0.5" />
            </g>

            {/* wires */}
            {placed.map(n => {
              const color = n.wire || '#555';
              const live = n.status === 'active';
              const err = n.status === 'error';
              return (
                <line
                  key={`w-${n.id}`}
                  x1={C} y1={C} x2={n.x} y2={n.y}
                  stroke={n.status === 'dead' ? '#2a2a2a' : color}
                  strokeWidth={live ? 2.4 : 1.4}
                  strokeOpacity={n.status === 'dead' ? 0.35 : 0.85}
                  strokeDasharray={n.wired ? (live ? undefined : '4 6') : '1 9'}
                  className={live && n.wired ? 'radar-wire-live' : undefined}
                  filter={live || err ? 'url(#radar-glow)' : undefined}
                />
              );
            })}

            {/* nodes */}
            {placed.map(n => {
              const color = STATUS_COLOR[n.status];
              const isSel = n.id === selected;
              const Icon = KIND_ICON[n.kind];
              return (
                <g key={n.id} onClick={() => setSelected(n.id)} style={{ cursor: 'pointer' }}>
                  {n.status === 'active' && (
                    <circle cx={n.x} cy={n.y} r={14} fill="none" stroke={color}
                      strokeWidth="1.5" className="radar-ring" opacity="0.6" />
                  )}
                  {n.status === 'error' && (
                    <circle cx={n.x} cy={n.y} r={14} fill="none" stroke={color}
                      strokeWidth="2" className="radar-ring radar-ring-error" />
                  )}
                  <circle cx={n.x} cy={n.y} r={isSel ? 20 : 17}
                    fill="#0a0f0c" stroke={isSel ? '#f2f2f2' : color}
                    strokeWidth={isSel ? 2.5 : 1.5} />
                  <foreignObject x={n.x - 9} y={n.y - 9} width={18} height={18}>
                    <div style={{ color }} className="flex items-center justify-center w-full h-full">
                      <Icon size={13} />
                    </div>
                  </foreignObject>
                  <circle cx={n.x + 13} cy={n.y - 13} r={4} fill={color}
                    className={`radar-dot radar-dot-${n.status}`} />
                  <text x={n.x} y={n.y + 32} textAnchor="middle"
                    fontSize="11" fontWeight="600" fill={isSel ? '#f2f2f2' : '#a5a5a5'}>
                    {n.name}
                  </text>
                  {n.latency_ms !== undefined && (
                    <text x={n.x} y={n.y + 44} textAnchor="middle" fontSize="9" fill="#777">
                      {n.latency_ms}ms
                    </text>
                  )}
                </g>
              );
            })}

            {/* centre: Movie Creator */}
            {centerNode && (
              <g onClick={() => setSelected('movie-creator')} style={{ cursor: 'pointer' }}>
                <circle cx={C} cy={C} r={54} fill="none" stroke="#54f893" strokeWidth="1" className="radar-ring" />
                <circle cx={C} cy={C} r={46} fill="#0a0f0c" stroke="#54f893" strokeWidth="2.5" filter="url(#radar-glow)" />
                <foreignObject x={C - 20} y={C - 26} width={40} height={40}>
                  <div className="flex items-center justify-center w-full h-full text-growth"><Film size={26} /></div>
                </foreignObject>
                <text x={C} y={C + 26} textAnchor="middle" fontSize="11" fontWeight="700" fill="#54f893">
                  MOVIE CREATOR
                </text>
                <text x={C} y={C + 38} textAnchor="middle" fontSize="8" fill="#777">gitna ng lahat</text>
              </g>
            )}
          </svg>

          {error && (
            <div className="absolute bottom-3 left-3 right-3 flex items-center gap-2 rounded-card border border-[#5a1f1f] bg-[#1a0d0d] px-3 py-2 text-[11px] text-[#ff8a8a]">
              <AlertTriangle size={13} /> {error}
            </div>
          )}
        </div>

        {/* detail panel */}
        <aside className="border-t lg:border-t-0 lg:border-l border-subtle bg-page-soft p-3 overflow-y-auto">
          <div className="flex items-center gap-2 mb-2 text-[10px] uppercase tracking-widest text-dim">
            <Crosshair size={12} /> Detalye ng node
          </div>

          {selectedNode ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-bold text-ink">{selectedNode.name}</div>
                  <div className="text-[11px] text-dim capitalize">{selectedNode.layer} · {selectedNode.kind}</div>
                </div>
                <span className="flex items-center gap-1.5 rounded-pill px-2 py-1 text-[10px] font-semibold"
                  style={{ background: `${STATUS_COLOR[selectedNode.status]}22`, color: STATUS_COLOR[selectedNode.status] }}>
                  <span className="radar-dot" style={{ width: 8, height: 8, background: STATUS_COLOR[selectedNode.status] }} />
                  {STATUS_LABEL[selectedNode.status]}
                </span>
              </div>

              <div className="rounded-card border border-subtle bg-sunken p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-dim mb-1">Ano ang nakita ng probe</div>
                <div className="text-[12px] text-ink">{selectedNode.detail}</div>
                <div className="mt-2 text-[10px] text-dim font-mono break-all">{selectedNode.probe}</div>
                {selectedNode.latency_ms !== undefined && (
                  <div className="mt-1 text-[10px] text-muted">Round-trip: {selectedNode.latency_ms} ms</div>
                )}
              </div>

              <div className="rounded-card border border-subtle bg-sunken p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-dim mb-1">Role sa app</div>
                <div className="text-[12px] text-ink">{selectedNode.role}</div>
              </div>

              <div className="rounded-card border border-subtle bg-sunken p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-dim mb-1">Koneksyon</div>
                <div className="flex items-center gap-2 text-[11px] text-ink">
                  <span className="inline-block h-2.5 w-6 rounded-pill"
                    style={{ background: selectedNode.wired ? (selectedNode.wire || '#555') : '#333' }} />
                  {selectedNode.wired ? 'May wire (kable)' : 'Wireless (over the network)'}
                </div>
              </div>

              {selectedNode.meta && Object.keys(selectedNode.meta).length > 0 && (
                <div className="rounded-card border border-subtle bg-sunken p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-dim mb-1.5">Meta</div>
                  <dl className="space-y-1">
                    {Object.entries(selectedNode.meta).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3 text-[11px]">
                        <dt className="text-dim">{k}</dt>
                        <dd className="text-ink font-mono text-right break-all">
                          {v === null || v === '' ? '—' : String(v)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          ) : (
            <div className="text-[12px] text-dim">Pumili ng node sa mapa.</div>
          )}

          {/* legend */}
          <div className="mt-4 border-t border-subtle pt-3">
            <div className="text-[10px] uppercase tracking-widest text-dim mb-2 flex items-center gap-1">
              <Power size={11} /> Kahulugan ng blink
            </div>
            <ul className="space-y-1.5 text-[11px]">
              <li className="flex items-center gap-2">
                <span className="radar-dot radar-dot-active" style={{ width: 10, height: 10, background: STATUS_COLOR.active }} />
                <span className="text-ink">Smooth na pagkidlat — buhay at honest</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="radar-dot radar-dot-error" style={{ width: 10, height: 10, background: STATUS_COLOR.error }} />
                <span className="text-ink">Hard na paulit-ulit — error o parating na crash</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="radar-dot radar-dot-standby" style={{ width: 10, height: 10, background: STATUS_COLOR.standby }} />
                <span className="text-ink">Mabagal na hininga — naka-configure, hindi pa verified</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="radar-dot" style={{ width: 10, height: 10, background: STATUS_COLOR.dead }} />
                <span className="text-ink">Itim at walang galaw — patay o wala</span>
              </li>
            </ul>
            {map && (
              <div className="mt-3 text-[10px] text-dim">
                Huling tsek: {new Date(map.checked_at).toLocaleTimeString()}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};
