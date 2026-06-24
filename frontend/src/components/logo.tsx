// ScholarLens logo — magnifying glass with document lines.
// LogoMark: bare SVG, inherits color via currentColor.
// LogoBadge: icon in the brand-purple rounded-square container.

export function LogoMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {/* Lens ring */}
      <circle cx="13" cy="13" r="8.5" stroke="currentColor" strokeWidth="2.2" />
      {/* Document lines — three text rows inside the lens */}
      <line x1="9" y1="10.5" x2="17" y2="10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="9" y1="13"   x2="17" y2="13"   stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="9" y1="15.5" x2="14" y2="15.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {/* Handle */}
      <line x1="19.5" y1="19.5" x2="26" y2="26" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function LogoBadge({ size = 32 }: { size?: number }) {
  return (
    <span
      className="relative flex items-center justify-center shrink-0 glow-gen"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.25),
        background: "var(--gen)",
      }}
    >
      <LogoMark size={Math.round(size * 0.58)} className="text-white" />
    </span>
  );
}
