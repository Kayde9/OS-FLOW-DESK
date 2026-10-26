/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: v("bg-0"), 1: v("bg-1"), 2: v("bg-2") },
        panel: { DEFAULT: v("panel"), raised: v("panel-raised"), sunk: v("panel-sunk") },
        steel: { DEFAULT: v("steel"), dim: v("steel-dim"), hi: v("steel-hi") },
        ink: { DEFAULT: v("ink"), 2: v("ink-2"), 3: v("ink-3") },
        amber: { DEFAULT: v("amber"), dim: v("amber-dim") },
        ok: v("ok"),
        info: v("info"),
        teal: v("teal"),
        violet: v("violet"),
        alert: v("alert"),
        cat: { file: v("cat-file"), workload: v("cat-workload"), disk: v("cat-disk"), process: v("cat-process") },
      },
      fontFamily: {
        sans: ["'IBM Plex Sans'", "system-ui", "Segoe UI", "sans-serif"],
        mono: ["'JetBrains Mono'", "Consolas", "monospace"],
      },
      fontSize: {
        // Smallest technical label size; kept at 10.5px for legibility.
        micro: ["10.5px", { lineHeight: "14px", letterSpacing: "0.08em" }],
      },
      borderRadius: { sm: "2px", DEFAULT: "3px", md: "4px" },
    },
  },
  plugins: [],
};
