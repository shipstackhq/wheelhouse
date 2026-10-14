const WHEEL_BLUE = "#2563eb";

/**
 * Flat, single-colour ship's wheel (thick rim, seven evenly wide handles) on a white rounded square.
 * Keep in sync with src/app/icon.svg, the favicon.
 */
export function WheelIcon({ className = "", size = 22 }: { className?: string; size?: number | string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={`shrink-0 ${className}`} aria-hidden>
      <rect width="32" height="32" rx="7" fill="#ffffff" />
      <g transform="translate(2.8 2.8) scale(1.1)" fill="none" stroke={WHEEL_BLUE} strokeWidth="2.75" strokeLinecap="round">
        <circle cx="12" cy="12" r="5" strokeWidth="4" />
        <path d="M12.00 6.00L12.00 1.10M16.69 8.26L20.52 5.20M17.85 13.34L22.63 14.43M14.60 17.41L16.73 21.82M9.40 17.41L7.27 21.82M6.15 13.34L1.37 14.43M7.31 8.26L3.48 5.20" />
      </g>
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <WheelIcon />
      <span>
        <span className="text-muted">Shipstack</span> Wheelhouse
      </span>
    </span>
  );
}
