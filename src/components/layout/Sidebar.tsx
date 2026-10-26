import { NavLink } from "react-router-dom";
import { Activity, Boxes, FlaskConical, FolderCog, Gauge, History, Microscope, Radar, Settings } from "lucide-react";
import { useEngine } from "../../lib/engine/store";
import { useCaptureState } from "../../lib/trace/store";

const NAV = [
  { to: "/", label: "Overview", icon: Gauge, code: "01" },
  { to: "/monitor", label: "Live Monitor", icon: Activity, code: "02" },
  { to: "/workspace", label: "Workspace", icon: FolderCog, code: "03" },
  { to: "/observatory", label: "Observatory", icon: Radar, code: "04" },
  { to: "/lab", label: "Algorithm Lab", icon: Microscope, code: "05" },
  { to: "/experiments", label: "Experiments", icon: FlaskConical, code: "06" },
  { to: "/history", label: "History", icon: History, code: "07" },
  { to: "/settings", label: "Settings", icon: Settings, code: "08" },
];

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <rect x="16" y="16" width="480" height="480" rx="72" fill="rgb(var(--bg-1))" stroke="rgb(var(--steel))" strokeWidth="20" />
      <path d="M84 276 H156 L190 176 L238 352 L284 140 L322 300 L350 236 H428" fill="none" stroke="rgb(var(--amber))" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="428" cy="236" r="24" fill="rgb(var(--ok))" />
    </svg>
  );
}

export function Sidebar() {
  const snap = useEngine();
  const active = snap?.jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "paused").length ?? 0;
  const capture = useCaptureState();
  return (
    <nav className="w-[208px] shrink-0 flex flex-col bg-bg-1 border-r border-steel-dim" aria-label="Main">
      <div className="h-[52px] flex items-center gap-2.5 px-4 border-b border-steel-dim">
        <Logo />
        <div className="leading-tight">
          <div className="text-[14px] font-semibold tracking-wide">FlowDesk</div>
          <div className="text-micro uppercase text-ink-3">OS Observatory</div>
        </div>
      </div>
      <ul className="flex-1 py-3 flex flex-col gap-0.5 px-2">
        {NAV.map(({ to, label, icon: Icon, code }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `group relative flex items-center gap-2.5 h-9 pl-3 pr-2 rounded-sm text-[13px] transition-colors ${
                  isActive
                    ? "bg-panel-raised text-ink border border-steel shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]"
                    : "text-ink-2 border border-transparent hover:bg-panel hover:text-ink"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-sm ${isActive ? "bg-amber shadow-[0_0_8px_rgb(var(--amber)/0.6)]" : "bg-transparent"}`} />
                  <Icon size={16} className={isActive ? "text-amber" : "text-ink-3 group-hover:text-ink-2"} />
                  <span className="flex-1">{label}</span>
                  {to === "/workspace" && active > 0 ? (
                    <span className="readout text-[10.5px] px-1.5 rounded-sm bg-amber/15 text-amber border border-amber/40">{active}</span>
                  ) : to === "/observatory" && capture === "capturing" ? (
                    <span className="readout text-[10px] px-1.5 rounded-sm bg-ok/10 text-ok border border-ok/40" title="An ETW capture is running">REC</span>
                  ) : (
                    <span className="readout text-[10px] text-ink-3/70">{code}</span>
                  )}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="px-4 py-3 border-t border-steel-dim text-[10.5px] text-ink-3 leading-relaxed">
        <div className="flex items-center gap-1.5">
          <Boxes size={12} /> <span className="uppercase tracking-[0.08em] font-semibold">Scope</span>
        </div>
        FlowDesk schedules its own jobs. It does not replace the Windows kernel scheduler.
      </div>
    </nav>
  );
}
