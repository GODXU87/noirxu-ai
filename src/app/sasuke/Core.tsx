'use client';

import { useEffect, useState } from 'react';

export type CoreState = 'idle' | 'thinking';

const TICKS = Array.from({ length: 60 }, (_, i) => i);

/**
 * SASUKE's presence: concentric rings that turn slowly while idle and speed up while
 * working. Pure SVG and CSS, so it costs nothing at rest and respects reduced motion.
 */
export function Core({ size = 180, state = 'idle' }: { size?: number; state?: CoreState }) {
  return (
    <div className={`core core-${state}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 200 200" width={size} height={size}>
        <defs>
          <radialGradient id="core-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#d8f7ff" stopOpacity=".95" />
            <stop offset="28%" stopColor="#5ce1ff" stopOpacity=".55" />
            <stop offset="70%" stopColor="#2f6bff" stopOpacity=".08" />
            <stop offset="100%" stopColor="#2f6bff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="core-arc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#5ce1ff" />
            <stop offset="100%" stopColor="#5ce1ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle cx="100" cy="100" r="96" fill="none" stroke="rgba(92,225,255,.12)" strokeWidth="1" />
        <g className="core-ring core-ticks">
          {TICKS.map(i => (
            <line key={i} x1="100" y1="8" x2="100" y2={i % 5 === 0 ? 16 : 12} stroke="rgba(92,225,255,.45)" strokeWidth={i % 5 === 0 ? 1.4 : .8} transform={`rotate(${i * 6} 100 100)`} />
          ))}
        </g>
        <g className="core-ring core-arcs">
          <circle cx="100" cy="100" r="78" fill="none" stroke="url(#core-arc)" strokeWidth="2" strokeDasharray="120 370" strokeLinecap="round" />
          <circle cx="100" cy="100" r="78" fill="none" stroke="rgba(92,225,255,.5)" strokeWidth="2" strokeDasharray="30 460" strokeDashoffset="-250" strokeLinecap="round" />
        </g>
        <g className="core-ring core-dash">
          <circle cx="100" cy="100" r="64" fill="none" stroke="rgba(120,160,255,.35)" strokeWidth="1" strokeDasharray="2 6" />
        </g>
        <g className="core-ring core-inner">
          <circle cx="100" cy="100" r="50" fill="none" stroke="rgba(92,225,255,.6)" strokeWidth="1.2" strokeDasharray="60 18 8 18" />
        </g>
        <circle className="core-glow" cx="100" cy="100" r="44" fill="url(#core-glow)" />
        <circle cx="100" cy="100" r="9" fill="#e9fbff" />
      </svg>
    </div>
  );
}

/** Live Taipei clock for the HUD bar. */
export function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!now) return <span className="hud-clock" />;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now).replace(/-/g, '.');
  return <span className="hud-clock">{date}<b>{time}</b>TPE</span>;
}
