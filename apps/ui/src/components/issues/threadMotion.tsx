import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
  type WheelEvent,
} from 'react';

/** Enter curve from the animation notes: fast start, soft settle. */
const ENTER_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

/** How close to the bottom still counts as following the stream. */
const PIN_PX = 48;

/**
 * Pixels to move toward the bottom this frame. A fraction of the gap, with a 1px floor,
 * so tokens ease in instead of the view jumping on every chunk. A gap under half a pixel
 * is already there.
 */
export function followStep(gap: number): number {
  if (gap <= 0.5) return 0;
  return Math.max(1, gap * 0.28);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** One-shot enter: fade, a short rise, and a scale from 0.97. Streaming updates do not replay it. */
export function playEnter(el: HTMLElement): void {
  if (prefersReducedMotion() || typeof el.animate !== 'function') return;
  el.animate(
    [
      { opacity: 0, transform: 'translateY(6px) scale(0.97)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: 200, easing: ENTER_EASING, fill: 'both' },
  );
}

/**
 * Wraps a new thread item so it enters once. Later text updates keep the same node.
 * `item` marks a row of the thread list.
 */
export function Enter({
  children,
  item = false,
  label,
}: {
  children: ReactNode;
  item?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transformOrigin = 'top center';
    playEnter(el);
  }, []);
  return (
    <div ref={ref} role={item ? 'listitem' : undefined} aria-label={label}>
      {children}
    </div>
  );
}

const gapBelow = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop;

/**
 * The thread's own scroller. While the reader is at the bottom, new and growing content
 * eases the scroll position down on the compositor's frames. Scrolling up lets go; a
 * button catches back up. The page itself does not move.
 */
export function ChatScroller({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const writing = useRef(false);
  const frame = useRef(0);
  const [caughtUp, setCaughtUp] = useState(true);

  function setFollowing(next: boolean) {
    if (following.current === next) return;
    following.current = next;
    setCaughtUp(next);
  }

  function tick() {
    const el = scroller.current;
    frame.current = 0;
    if (!el || !following.current) return;
    const gap = gapBelow(el);
    if (prefersReducedMotion()) {
      writing.current = true;
      el.scrollTop = el.scrollHeight;
      writing.current = false;
      return;
    }
    const step = followStep(gap);
    if (step === 0) return;
    const before = el.scrollTop;
    writing.current = true;
    el.scrollTop += step;
    writing.current = false;
    // A scroller that ignores the write (already clamped, or a test DOM) must not spin.
    if (el.scrollTop === before) return;
    frame.current = requestAnimationFrame(tick);
  }

  function kick() {
    if (frame.current !== 0) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(tick);
  }

  useLayoutEffect(() => {
    kick();
  });

  useEffect(() => {
    const inner = content.current;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => kick());
    observer.observe(inner);
    return () => {
      observer.disconnect();
      if (frame.current !== 0) cancelAnimationFrame(frame.current);
    };
  }, []);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    if (writing.current) return;
    setFollowing(gapBelow(event.currentTarget) < PIN_PX);
  }

  // A wheel upward is the reader leaving the live end, even before the scroll event lands.
  function onWheel(event: WheelEvent<HTMLDivElement>) {
    if (event.deltaY < 0) setFollowing(false);
  }

  return (
    <div className="relative">
      <div
        ref={scroller}
        role="region"
        aria-label={label}
        tabIndex={0}
        onScroll={onScroll}
        onWheel={onWheel}
        className="max-h-[min(70vh,42rem)] overflow-y-auto outline-none"
        style={{ overflowAnchor: 'none' }}
      >
        <div ref={content} className="space-y-5 py-1">
          {children}
        </div>
      </div>
      {!caughtUp && (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-background px-3 py-1 text-xs font-medium shadow-sm"
          onClick={() => {
            setFollowing(true);
            kick();
          }}
        >
          Latest
        </button>
      )}
    </div>
  );
}
