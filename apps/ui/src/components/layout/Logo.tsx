/**
 * The Page.AI mark: a P drawn as one spline, stem flowing into the bowl, with a page going
 * out beside it as two broadcast arcs. Strokes take the text colour, so it works in both
 * themes.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {/* The P: up the stem, over the bowl, and back in to meet it in one curve. */}
      <path
        d="M8 27.5V11.5C8 7.36 11.13 4 15.25 4C19.37 4 22.5 7.13 22.5 11C22.5 14.87 19.37 18 15.5 18C13.6 18 12 17.3 10.9 16.1"
        strokeWidth="2.6"
      />
      {/* The page going out. */}
      <path
        d="M25.6 7.2C27.1 8.6 27.9 10.3 27.9 12C27.9 13.7 27.1 15.4 25.6 16.8"
        strokeWidth="2.2"
      />
      <path
        d="M28.6 4.6C30.6 6.6 31.6 9.2 31.6 12C31.6 14.8 30.6 17.4 28.6 19.4"
        strokeWidth="1.6"
        opacity="0.45"
      />
    </svg>
  );
}

/** The mark with the wordmark beside it. */
export default function Logo() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark className="size-7 text-foreground" />
      <span className="text-[17px] font-semibold tracking-tight">
        Page<span className="text-muted-foreground">.AI</span>
      </span>
    </span>
  );
}
