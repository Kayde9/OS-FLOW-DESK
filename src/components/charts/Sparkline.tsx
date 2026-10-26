import { memo } from "react";

/** Tiny trend line; nulls (unavailable samples) break the line rather than drawing zeros. */
export const Sparkline = memo(function Sparkline({
  values,
  color,
  max,
  height = 30,
}: {
  values: (number | null)[];
  color: string;
  max?: number;
  height?: number;
}) {
  const w = 120;
  const finite = values.filter((v): v is number => v != null);
  const hi = max ?? Math.max(1e-9, ...finite);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    const x = i * step;
    const y = height - 2 - (Math.min(v, hi) / hi) * (height - 4);
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full h-full" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
});
