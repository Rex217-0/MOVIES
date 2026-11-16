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
 *
 * The chrome around it is a tactical HUD built entirely from CSS (angular
 * windows, corner brackets, a scanline wash), so nothing here needs an image
 * asset or a licence. Every number on screen comes from the probe response or
 * the clock; the panel invents nothing.
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

const STATUS_ORDER: NodeStatus[] = ['active', 'error', 'standby', 'dead'];

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

/** A clipped HUD window with a label bar. Pure chrome; children carry the data. */
const HudWindow: React.FC<{ label: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  label, icon, children, className = '',
}) => (
  <section className={`hud-panel flex min-h-0 flex-col ${className}`}>
    <header className="flex items-center gap-2 border-b border-[#1c3326] px-3 py-1.5">
      {icon}
      <span className="hud-panel-label">{label}</span>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
  </section>
);

export const TacticalRadarMap: React.FC = () => {
  const [map, setMap] = useState<SystemMap | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>('movie-creator');
  const [auto, setAuto] = useState(true);
  const [now, setNow] = useState(() => new Date());
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

  // A live clock is the only thing on screen not tied to a probe; it is real
  // time, not decoration.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const placed = useMemo(() => (map ? placeNodes(map.nodes) : []), [map]);
  const centerNode = map?.nodes.find(n => n.layer === 'center');
  const selectedNode = placed.find(n => n.id === selected) ?? centerNode;

  const counts = map?.counts ?? { active: 0, error: 0, standby: 0, dead: 0 };
  const total = map?.nodes.length ?? 0;
  const health = total ? Math.round((counts.active / total) * 100) : 0;
  const liveWires = placed.filter(n => n.status === 'active' && n.wired).length;

  const clock = now.toLocaleTimeString('en-GB', { hour12: false });
  const stamp = now.toLocaleDateString('en-GB');

  const ticker = placed
    .map(n => `[${n.status.toUpperCase()}] ${n.name}${n.latency_ms !== undefined ? ` ${n.latency_ms}ms` : ''}`)
    .join('   ·   ');

  return (
    <div className="hud-frame flex h-full flex-col overflow-hidden rounded-card">
      <span className="hud-corner hud-corner-tl" />
      <span className="hud-corner hud-corner-tr" />
      <span className="hud-corner hud-corner-bl" />
      <span className="hud-corner hud-corner-br" />
      <div className="hud-scan" />

      {/* command bar */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-2 border-b border-[#1c3326] bg-[#060b09] px-3 py-2">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-growth" />
          <h2 className="hud-title text-xs font-bold text-growth">Tactical Systems Console</h2>
          <span className="rounded-pill border border-[#1c3326] px-2 py-0.5 text-[9px] text-muted">
            movie-creator · v1.0
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted">
          <span className="font-mono text-growth">{clock}</span>
          <span className="font-mono text-dim">{stamp}</span>
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${auto ? 'radar-dot radar-dot-active bg-growth' : 'bg-dim'}`} />
            {auto ? 'LIVE' : 'PAUSED'}
          </span>
          <button
            onClick={() => setAuto(a => !a)}
            className={`btn-ghost flex items-center gap-1 px-2 py-1 text-[10px] ${auto ? 'text-growth' : 'text-dim'}`}
            title="Auto-refresh tuwing 20s"
          >
            <Activity size={11} /> {auto ? 'HOLD' : 'RESUME'}
          </button>
          <button onClick={() => void load()} className="btn-ghost flex items-center gap-1 px-2 py-1 text-[10px]">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> REFRESH
          </button>
        </div>
      </div>

      {/* vitals strip */}
      <div className="relative z-10 grid grid-cols-2 gap-px border-b border-[#1c3326] bg-[#1c3326] sm:grid-cols-4">
        {STATUS_ORDER.map(s => (
          <div key={s} className="flex items-center justify-between bg-[#060b09] px-3 py-1.5">
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-dim">
              <span className="radar-dot" style={{ width: 8, height: 8, background: STATUS_COLOR[s] }} />
              {s}
            </span>
            <span className="font-mono text-sm font-bold" style={{ color: STATUS_COLOR[s] }}>{counts[s]}</span>
          </div>
        ))}
      </div>

      <div className="relative z-10 grid min-h-0 flex-1 gap-2 p-2 lg:grid-cols-[1fr_330px]">
        {/* radar scope */}
        <div className="relative flex min-h-[420px] items-center justify-center overflow-hidden">
          <svg viewBox={`0 0 ${VIEW} ${VIEW}`} className="h-full max-h-[68vh] w-full">
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

            {/* crosshair axes */}
            <line x1={C} y1={20} x2={C} y2={VIEW - 20} stroke="#16241c" strokeWidth="1" />
            <line x1={20} y1={C} x2={VIEW - 20} y2={C} stroke="#16241c" strokeWidth="1" />

            {/* range rings with labels */}
            {[RING.behind, RING.left, RING.front].map((r, i) => (
              <g key={i}>
                <circle cx={C} cy={C} r={r} fill="none"
                  stroke="#1f3a2a" strokeWidth="1" strokeDasharray="3 6" />
                <text x={C + 4} y={C - r - 3} fontSize="8" fill="#2f5741" className="font-mono">{r}</text>
              </g>
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
                  {/* tactical target box on the selected node */}
                  {isSel && (
                    <rect x={n.x - 26} y={n.y - 26} width={52} height={52} fill="none"
                      stroke="#f2f2f2" strokeWidth="1" strokeDasharray="6 4" opacity="0.7" />
                  )}
                  <circle cx={n.x} cy={n.y} r={isSel ? 20 : 17}
                    fill="#0a0f0c" stroke={isSel ? '#f2f2f2' : color}
                    strokeWidth={isSel ? 2.5 : 1.5} />
                  <foreignObject x={n.x - 9} y={n.y - 9} width={18} height={18}>
                    <div style={{ color }} className="flex h-full w-full items-center justify-center">
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
                    <text x={n.x} y={n.y + 44} textAnchor="middle" fontSize="9" fill="#777" className="font-mono">
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
                  <div className="flex h-full w-full items-center justify-center text-growth"><Film size={26} /></div>
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

        {/* right-hand windows */}
        <div className="grid min-h-0 gap-2 lg:grid-rows-[auto_1fr_auto]">
          <HudWindow label="System vitals" icon={<Power size={11} className="text-growth" />}>
            <div className="space-y-2">
              <div className="flex items-end justify-between">
                <span className="text-[10px] uppercase tracking-wider text-dim">Integridad</span>
                <span className="font-mono text-lg font-bold text-growth">{health}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-pill bg-[#12241a]">
                <div className="h-full rounded-pill bg-growth" style={{ width: `${health}%` }} />
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 text-[11px]">
                <dt className="text-dim">Nodes</dt>
                <dd className="text-right font-mono text-ink">{total}</dd>
                <dt className="text-dim">Live wires</dt>
                <dd className="text-right font-mono text-ink">{liveWires}</dd>
                <dt className="text-dim">Huling tsek</dt>
                <dd className="text-right font-mono text-ink">
                  {map ? new Date(map.checked_at).toLocaleTimeString() : '—'}
                </dd>
              </dl>
            </div>
          </HudWindow>

          <HudWindow label="Node detail" icon={<Crosshair size={12} className="text-growth" />}>
            {selectedNode ? (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-bold text-ink">{selectedNode.name}</div>
                    <div className="text-[11px] capitalize text-dim">{selectedNode.layer} · {selectedNode.kind}</div>
                  </div>
                  <span className="flex items-center gap-1.5 rounded-pill px-2 py-1 text-[10px] font-semibold"
                    style={{ background: `${STATUS_COLOR[selectedNode.status]}22`, color: STATUS_COLOR[selectedNode.status] }}>
                    <span className="radar-dot" style={{ width: 8, height: 8, background: STATUS_COLOR[selectedNode.status] }} />
                    {STATUS_LABEL[selectedNode.status]}
                  </span>
                </div>

                <div className="rounded-card border border-[#1c3326] bg-[#060b09] p-2.5">
                  <div className="hud-panel-label mb-1">Ano ang nakita ng probe</div>
                  <div className="text-[12px] text-ink">{selectedNode.detail}</div>
                  <div className="mt-2 break-all font-mono text-[10px] text-dim">{selectedNode.probe}</div>
                  {selectedNode.latency_ms !== undefined && (
                    <div className="mt-1 text-[10px] text-muted">Round-trip: {selectedNode.latency_ms} ms</div>
                  )}
                </div>

                <div className="rounded-card border border-[#1c3326] bg-[#060b09] p-2.5">
                  <div className="hud-panel-label mb-1">Role sa app</div>
                  <div className="text-[12px] text-ink">{selectedNode.role}</div>
                </div>

                <div className="rounded-card border border-[#1c3326] bg-[#060b09] p-2.5">
                  <div className="hud-panel-label mb-1">Koneksyon</div>
                  <div className="flex items-center gap-2 text-[11px] text-ink">
                    <span className="inline-block h-2.5 w-6 rounded-pill"
                      style={{ background: selectedNode.wired ? (selectedNode.wire || '#555') : '#333' }} />
                    {selectedNode.wired ? 'May wire (kable)' : 'Wireless (over the network)'}
                  </div>
                </div>

                {selectedNode.meta && Object.keys(selectedNode.meta).length > 0 && (
                  <div className="rounded-card border border-[#1c3326] bg-[#060b09] p-2.5">
                    <div className="hud-panel-label mb-1.5">Meta</div>
                    <dl className="space-y-1">
                      {Object.entries(selectedNode.meta).map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-3 text-[11px]">
                          <dt className="text-dim">{k}</dt>
                          <dd className="break-all text-right font-mono text-ink">
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
          </HudWindow>

          <HudWindow label="Comms · status ng signal" icon={<Activity size={11} className="text-growth" />}>
            <ul className="space-y-1">
              {placed.map(n => (
                <li key={`feed-${n.id}`}>
                  <button
                    onClick={() => setSelected(n.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-card px-2 py-1 text-left text-[11px] transition-colors hover:bg-[#0d1a12] ${n.id === selected ? 'bg-[#0d1a12]' : ''}`}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <span className="radar-dot" style={{ width: 7, height: 7, background: STATUS_COLOR[n.status] }} />
                      <span className="truncate text-ink">{n.name}</span>
                    </span>
                    <span className="font-mono text-[10px] text-dim">
                      {n.latency_ms !== undefined ? `${n.latency_ms}ms` : n.status}
                    </span>
                  </button>
                </li>
              ))}
              {!placed.length && <li className="text-[11px] text-dim">Wala pang probe data.</li>}
            </ul>
          </HudWindow>
        </div>
      </div>

      {/* legend + ticker */}
      <div className="relative z-10 border-t border-[#1c3326] bg-[#060b09] px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="radar-dot radar-dot-active" style={{ width: 9, height: 9, background: STATUS_COLOR.active }} />
            Buhay at honest
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <span className="radar-dot radar-dot-error" style={{ width: 9, height: 9, background: STATUS_COLOR.error }} />
            Error / parating na crash
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <span className="radar-dot radar-dot-standby" style={{ width: 9, height: 9, background: STATUS_COLOR.standby }} />
            Naka-configure, hindi pa verified
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <span className="radar-dot" style={{ width: 9, height: 9, background: STATUS_COLOR.dead }} />
            Patay o wala
          </span>
        </div>
        <div className="hud-ticker mt-1 font-mono text-[10px] text-dim">
          <span>{ticker}{ticker ? '   ·   ' : ''}{ticker}</span>
        </div>
      </div>
    </div>
  );
};
