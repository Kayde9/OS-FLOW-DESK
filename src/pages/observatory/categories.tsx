// Category encoding: three validated hues + a neutral steel family told apart
// by shape (see --cat-* tokens in index.css). Identity is never color alone:
// every use pairs the glyph with a text label.

export type Shape = "tick" | "diamond" | "triangle" | "square" | "flag";

export const CAT: Record<string, { label: string; token: string; shape: Shape }> = {
  file: { label: "File I/O", token: "--cat-file", shape: "tick" },
  disk: { label: "Disk I/O", token: "--cat-disk", shape: "tick" },
  process: { label: "Process", token: "--cat-process", shape: "diamond" },
  thread: { label: "Thread", token: "--cat-process", shape: "triangle" },
  image: { label: "Image load", token: "--cat-process", shape: "square" },
  workload: { label: "FlowDesk workload", token: "--cat-workload", shape: "flag" },
};

export const catOf = (c: string) => CAT[c] ?? { label: c, token: "--cat-process", shape: "diamond" as Shape };

/** Resolved rgb() for canvas drawing. */
export function cssColor(token: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim() || "169 176 179";
  return `rgb(${v} / ${alpha})`;
}

export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, x: number, y: number, s: number) {
  ctx.beginPath();
  switch (shape) {
    case "diamond":
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      break;
    case "triangle":
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y + s * 0.8);
      ctx.lineTo(x - s, y + s * 0.8);
      break;
    case "square":
      ctx.rect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6);
      break;
    case "flag":
      ctx.rect(x - 1, y - s - 2, 2, s * 2 + 4);
      ctx.moveTo(x + 1, y - s - 2);
      ctx.lineTo(x + s + 2, y - s + 1);
      ctx.lineTo(x + 1, y - s + 4);
      break;
    default:
      ctx.rect(x - 1, y - s, 2, s * 2);
  }
  ctx.closePath();
  ctx.fill();
}

export function CatGlyph({ category, size = 10 }: { category: string; size?: number }) {
  const c = catOf(category);
  const fill = `rgb(var(${c.token}))`;
  const h = size / 2;
  const path: Record<Shape, string> = {
    tick: `M${h - 1.2} 0h2.4v${size}h-2.4z`,
    diamond: `M${h} 0L${size} ${h}L${h} ${size}L0 ${h}z`,
    triangle: `M${h} 0L${size} ${size}H0z`,
    square: `M1 1h${size - 2}v${size - 2}H1z`,
    flag: `M1 0h1.6v${size}H1zM2.6 0L${size} 2.6L2.6 5.2z`,
  };
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0">
      <path d={path[c.shape]} fill={fill} />
    </svg>
  );
}

export function CatLabel({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <CatGlyph category={category} />
      <span className="truncate">{catOf(category).label}</span>
    </span>
  );
}

export function SourceBadge({ source }: { source: string }) {
  return source === "etw" ? (
    <span className="live-badge" title="Observed by a Windows ETW provider">ETW observation</span>
  ) : (
    <span
      className="inline-flex items-center px-1.5 h-5 rounded-sm border border-cat-workload/60 text-micro uppercase font-semibold text-ink-2"
      title="Emitted by FlowDesk's own job engine — an application-level event, not an OS observation"
    >
      FlowDesk app event
    </span>
  );
}
