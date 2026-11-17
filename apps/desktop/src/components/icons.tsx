import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = ({ size = 16, ...p }: P) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p,
});

export const IconPlay = (p: P) => <svg {...base(p)}><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" /></svg>;
export const IconPause = (p: P) => <svg {...base(p)}><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></svg>;
export const IconStop = (p: P) => <svg {...base(p)}><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" /></svg>;
export const IconPrev = (p: P) => <svg {...base(p)}><path d="M18 6l-8 6 8 6zM6 6v12" /></svg>;
export const IconNext = (p: P) => <svg {...base(p)}><path d="M6 6l8 6-8 6zM18 6v12" /></svg>;
export const IconRestart = (p: P) => <svg {...base(p)}><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" /></svg>;
export const IconLoop = (p: P) => <svg {...base(p)}><path d="M17 2l3 3-3 3M3 11V9a4 4 0 0 1 4-4h13M7 22l-3-3 3-3M21 13v2a4 4 0 0 1-4 4H4" /></svg>;
export const IconMetronome = (p: P) => <svg {...base(p)}><path d="M9 3h6l4 18H5zM12 15l5-9M7.5 15h9" /></svg>;
export const IconVolume = (p: P) => <svg {...base(p)}><path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7" /></svg>;
export const IconNew = (p: P) => <svg {...base(p)}><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M12 11v6M9 14h6" /></svg>;
export const IconOpen = (p: P) => <svg {...base(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H7l-4 9z" /><path d="M3 19l3.5-8H22l-3.5 8z" /></svg>;
export const IconSave = (p: P) => <svg {...base(p)}><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v5h8V3M7 21v-7h10v7" /></svg>;
export const IconImport = (p: P) => <svg {...base(p)}><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></svg>;
export const IconExport = (p: P) => <svg {...base(p)}><path d="M12 15V3M7 8l5-5 5 5M4 21h16" /></svg>;
export const IconUndo = (p: P) => <svg {...base(p)}><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" /></svg>;
export const IconRedo = (p: P) => <svg {...base(p)}><path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" /></svg>;
export const IconSearch = (p: P) => <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;
export const IconSettings = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
export const IconUser = (p: P) => <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
export const IconCoin = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9 9.5c0-1 1.3-1.8 3-1.8s3 .8 3 1.8-1.3 1.7-3 1.7-3 .8-3 1.8 1.3 1.8 3 1.8 3-.8 3-1.8" /></svg>;
export const IconPanelLeft = (p: P) => <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>;
export const IconPanelRight = (p: P) => <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>;
export const IconSun = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
export const IconMoon = (p: P) => <svg {...base(p)}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>;
export const IconLightbulb = (p: P) => <svg {...base(p)}><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" /></svg>;
export const IconX = (p: P) => <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const IconCheck = (p: P) => <svg {...base(p)}><path d="M5 12.5l4.5 4.5L19 7" /></svg>;
export const IconMic = (p: P) => <svg {...base(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>;
export const IconZoomIn = (p: P) => <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5M8 11h6M11 8v6" /></svg>;
export const IconZoomOut = (p: P) => <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5M8 11h6" /></svg>;
export const IconLogo = (p: P) => (
  <svg {...base(p)} viewBox="0 0 32 32" stroke="none">
    <rect width="32" height="32" rx="8" fill="var(--accent)" />
    <path d="M16 6v14.5a3.5 3.5 0 1 1-2-3.2V9l8-2v3l-6 1.6" fill="none" stroke="var(--accent-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 9h4M11 7v4" stroke="var(--accent-text)" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
