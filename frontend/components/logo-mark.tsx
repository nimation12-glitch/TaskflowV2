export function LogoMark({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="TaskFlow"
    >
      <rect width="64" height="64" rx="14" fill="url(#tf-logo-grad)" />
      <rect x="14" y="34" width="9" height="14" rx="3" fill="white" />
      <rect x="27.5" y="26" width="9" height="22" rx="3" fill="white" />
      <rect x="41" y="16" width="9" height="32" rx="3" fill="#C8F04A" />
      <defs>
        <linearGradient id="tf-logo-grad" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3B82F6" />
          <stop offset="1" stopColor="#142C5D" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function LogoWordmark({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <span className={`flex items-center gap-2 text-[15px] font-semibold tracking-tight ${className ?? ""}`}>
      <LogoMark size={size} />
      TaskFlow
    </span>
  );
}
