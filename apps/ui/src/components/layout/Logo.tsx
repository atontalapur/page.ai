/**
 * The Page.AI mark: four rounded corner brackets, open at the middle of each side, framing
 * a filled page. Both take the text colour, the page at reduced opacity, so it works in
 * both themes.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect
        x="6.6"
        y="6.6"
        width="18.8"
        height="18.8"
        rx="3.2"
        fill="currentColor"
        stroke="none"
        opacity="0.42"
      />
      <path d="M2.8 12.4V9.2A6.4 6.4 0 0 1 9.2 2.8H12.4" />
      <path d="M19.6 2.8H22.8A6.4 6.4 0 0 1 29.2 9.2V12.4" />
      <path d="M29.2 19.6V22.8A6.4 6.4 0 0 1 22.8 29.2H19.6" />
      <path d="M12.4 29.2H9.2A6.4 6.4 0 0 1 2.8 22.8V19.6" />
    </svg>
  );
}

/** The mark alone; the name is there for screen readers. */
export default function Logo() {
  return (
    <span className="flex items-center">
      <LogoMark className="size-7 text-foreground" />
      <span className="sr-only">Page.AI</span>
    </span>
  );
}
