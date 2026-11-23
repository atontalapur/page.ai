import { useEffect, useRef } from 'react';
import type { KgEdge, KgNode } from '@page/contracts';

interface Props {
  nodes: KgNode[];
  edges: KgEdge[];
  /** The node open in the page beside the graph. */
  selected: string | undefined;
  /** Search matches, ringed in the accent colour. */
  highlighted: ReadonlySet<string>;
  onSelect: (key: string) => void;
}

interface Body {
  key: string;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  /** A test file: drawn smaller and fainter, so the code it tests stands out. */
  test: boolean;
  /** Held by the pointer: the simulation leaves it where the pointer puts it. */
  pinned: boolean;
}

// The forces, tuned by eye to read like Obsidian's graph view.
const REPULSION = 2200;
const SPRING = 0.015;
const SPRING_LENGTH = 110;
const GRAVITY = 0.0025;
const DAMPING = 0.85;
// Steps a new graph settles for before it is first drawn, so it opens calm, not exploding.
const SETTLE_STEPS = 300;
// Labels fade in between these zoom levels.
// Below LABEL_FROM only the focused node, its neighbours and search matches are named.
const LABEL_FROM = 1.6;
const LABEL_FULL = 2.4;

const radius = (b: Body) => Math.min(7, 2.5 + Math.sqrt(b.degree) * 1.2);

/** The short name a node shows: its file name, without the path or a "Tests:" prefix. */
export function shortLabel(node: Pick<KgNode, 'key' | 'title'>): string {
  const path = node.key.replace(/^[a-z_]+:/, '').split('#')[0] ?? node.key;
  return path.split('/').pop() || node.title;
}

interface Sim {
  bodies: Map<string, Body>;
  links: [string, string][];
  heat: number;
}

/** One step of the forces: every pair repels, every link pulls, everything drifts in. */
function step(s: Sim) {
  const bodies = [...s.bodies.values()];
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i]!;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j]!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = Math.max(dx * dx + dy * dy, 25);
      const f = REPULSION / d2;
      const d = Math.sqrt(d2);
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
  }
  for (const [from, to] of s.links) {
    const a = s.bodies.get(from)!;
    const b = s.bodies.get(to)!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const f = (d - SPRING_LENGTH) * SPRING;
    a.vx += (dx / d) * f;
    a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f;
    b.vy -= (dy / d) * f;
  }
  for (const b of bodies) {
    if (b.pinned) {
      b.vx = 0;
      b.vy = 0;
      continue;
    }
    b.vx = (b.vx - b.x * GRAVITY) * DAMPING * s.heat;
    b.vy = (b.vy - b.y * GRAVITY) * DAMPING * s.heat;
    b.x += b.vx;
    b.y += b.vy;
  }
  s.heat = Math.max(0.6, s.heat * 0.995);
}
const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * The knowledge graph as Obsidian draws it: a force layout on a canvas, nodes sized by
 * their links, faint edges, labels that fade in as you zoom, and hover that lights a node
 * and its neighbours while the rest dims. Drag the background to pan, scroll to zoom, drag
 * a node to move it, click one to open it.
 */
export default function GraphCanvas({ nodes, edges, selected, highlighted, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({
    bodies: new Map<string, Body>(),
    links: [] as [string, string][],
    view: { x: 0, y: 0, scale: 1 },
    hover: undefined as string | undefined,
    drag: undefined as { key?: string; x: number; y: number; moved: boolean } | undefined,
    heat: 1,
    /** Fit the view to the graph on the next frame: set when a new graph arrives. */
    fit: true,
    selected,
    highlighted,
  });
  state.current.selected = selected;
  state.current.highlighted = highlighted;

  // Keep the bodies already placed, so new data settles in instead of starting over.
  useEffect(() => {
    const s = state.current;
    const next = new Map<string, Body>();
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    nodes.forEach((n, i) => {
      const old = s.bodies.get(n.key);
      const angle = i * 2.399963; // the golden angle, so new nodes spread out evenly
      const r = 20 * Math.sqrt(i + 1);
      next.set(n.key, {
        key: n.key,
        label: shortLabel(n),
        x: old?.x ?? Math.cos(angle) * r,
        y: old?.y ?? Math.sin(angle) * r,
        vx: old?.vx ?? 0,
        vy: old?.vy ?? 0,
        degree: degree.get(n.key) ?? 0,
        test: n.kind === 'test',
        pinned: false,
      });
    });
    s.bodies = next;
    const fresh = nodes.filter((n) => !s.bodies.has(n.key)).length;
    s.links = edges.filter((e) => next.has(e.from) && next.has(e.to)).map((e) => [e.from, e.to]);
    s.heat = 1;
    // A graph mostly new to the canvas settles out of sight, then is framed.
    if (fresh > nodes.length / 2) {
      for (let i = 0; i < SETTLE_STEPS; i++) step(s);
      s.fit = true;
    }
  }, [nodes, edges]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const s = state.current;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;

    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const { view } = s;
      if (s.fit && width > 0 && s.bodies.size > 0) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const b of s.bodies.values()) {
          minX = Math.min(minX, b.x);
          maxX = Math.max(maxX, b.x);
          minY = Math.min(minY, b.y);
          maxY = Math.max(maxY, b.y);
        }
        const pad = 40;
        view.scale = Math.min(
          1.2,
          Math.max(
            0.2,
            Math.min(
              (width - pad * 2) / (maxX - minX || 1),
              (height - pad * 2) / (maxY - minY || 1),
            ),
          ),
        );
        view.x = -((minX + maxX) / 2) * view.scale;
        view.y = -((minY + maxY) / 2) * view.scale;
        s.fit = false;
      }
      const fg = cssVar('--slate-11');
      const faint = cssVar('--slate-a6');
      const accent = cssVar('--violet-9');
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(width / 2 + view.x, height / 2 + view.y);
      ctx.scale(view.scale, view.scale);

      const focus = s.hover ?? s.selected;
      const near = new Set<string>(focus ? [focus] : []);
      if (focus) {
        for (const [a, b] of s.links) {
          if (a === focus) near.add(b);
          if (b === focus) near.add(a);
        }
      }
      const dimmed = (key: string) => s.hover !== undefined && !near.has(key);

      ctx.lineWidth = 1 / view.scale;
      for (const [from, to] of s.links) {
        const a = s.bodies.get(from)!;
        const b = s.bodies.get(to)!;
        const lit = focus !== undefined && (from === focus || to === focus);
        ctx.strokeStyle = lit ? accent : faint;
        ctx.globalAlpha = s.hover !== undefined && !lit ? 0.08 : lit ? 0.9 : 0.35;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      const labelAlpha = Math.min(
        1,
        Math.max(0, (view.scale - LABEL_FROM) / (LABEL_FULL - LABEL_FROM)),
      );
      ctx.font = `${10.5 / view.scale}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const b of s.bodies.values()) {
        const r = radius(b);
        const isFocus = b.key === focus;
        const lit = isFocus || (near.has(b.key) && s.hover !== undefined);
        ctx.globalAlpha = dimmed(b.key) ? 0.12 : b.test && !lit ? 0.45 : 1;
        ctx.fillStyle = lit ? accent : fg;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.test ? r * 0.7 : r, 0, Math.PI * 2);
        ctx.fill();
        if (s.highlighted.has(b.key)) {
          ctx.strokeStyle = accent;
          ctx.lineWidth = 2 / view.scale;
          ctx.beginPath();
          ctx.arc(b.x, b.y, r + 3 / view.scale, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1 / view.scale;
        }
        // The focused node, its neighbours and search matches always show their names.
        const alpha = near.has(b.key) || s.highlighted.has(b.key) ? 1 : labelAlpha;
        if (alpha > 0.02 && !dimmed(b.key)) {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = fg;
          ctx.fillText(b.label, b.x, b.y + r + 3 / view.scale);
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    };

    const tick = () => {
      step(s);
      draw();
      frame = requestAnimationFrame(tick);
    };
    if (reduceMotion) {
      for (let i = 0; i < 300; i++) step(s);
      draw();
    } else {
      frame = requestAnimationFrame(tick);
    }

    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const { view } = s;
      return {
        x: (clientX - rect.left - rect.width / 2 - view.x) / view.scale,
        y: (clientY - rect.top - rect.height / 2 - view.y) / view.scale,
      };
    };
    const hit = (clientX: number, clientY: number) => {
      const p = toWorld(clientX, clientY);
      let best: Body | undefined;
      let bestD = Infinity;
      for (const b of s.bodies.values()) {
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < radius(b) + 6 / s.view.scale && d < bestD) {
          best = b;
          bestD = d;
        }
      }
      return best;
    };

    const down = (e: PointerEvent) => {
      const body = hit(e.clientX, e.clientY);
      if (body) body.pinned = true;
      s.drag = { ...(body ? { key: body.key } : {}), x: e.clientX, y: e.clientY, moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const drag = s.drag;
      if (!drag) {
        const body = hit(e.clientX, e.clientY);
        s.hover = body?.key;
        canvas.style.cursor = body ? 'pointer' : 'grab';
        if (reduceMotion) draw();
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.key) {
        const body = s.bodies.get(drag.key);
        const p = toWorld(e.clientX, e.clientY);
        if (body) {
          body.x = p.x;
          body.y = p.y;
        }
        s.heat = 1;
      } else {
        s.view.x += dx;
        s.view.y += dy;
        canvas.style.cursor = 'grabbing';
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (reduceMotion) draw();
    };
    const up = () => {
      const drag = s.drag;
      s.drag = undefined;
      if (!drag) return;
      if (drag.key) {
        const body = s.bodies.get(drag.key);
        if (body) body.pinned = false;
        if (!drag.moved) onSelect(drag.key);
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const before = toWorld(e.clientX, e.clientY);
      s.view.scale = Math.min(4, Math.max(0.2, s.view.scale * Math.exp(-e.deltaY * 0.0015)));
      const after = toWorld(e.clientX, e.clientY);
      s.view.x += (after.x - before.x) * s.view.scale;
      s.view.y += (after.y - before.y) * s.view.scale;
      if (reduceMotion) draw();
    };
    const leave = () => {
      s.hover = undefined;
      if (reduceMotion) draw();
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
    };
  }, [onSelect]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={`Knowledge graph: ${nodes.length} nodes and ${edges.length} links. Pick a node from the list to open it.`}
      className="h-full w-full cursor-grab touch-none"
    />
  );
}
