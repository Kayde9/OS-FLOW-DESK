import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Binary, Cpu, Database, GitBranch, HardDrive, Layers, Lock, Network } from "lucide-react";
import CpuLab from "./CpuLab";
import ProcessLab from "./ProcessLab";
import ConcurrencyLab from "./ConcurrencyLab";
import DeadlockLab from "./DeadlockLab";
import MemoryLab from "./MemoryLab";
import DiskLab from "./DiskLab";
import FsLab from "./FsLab";
import ArchLab from "./ArchLab";

const CATS = [
  { path: "cpu", label: "CPU Scheduling", icon: Cpu, el: <CpuLab /> },
  { path: "process", label: "Process Management", icon: GitBranch, el: <ProcessLab /> },
  { path: "concurrency", label: "Concurrency", icon: Lock, el: <ConcurrencyLab /> },
  { path: "deadlock", label: "Deadlocks", icon: Network, el: <DeadlockLab /> },
  { path: "memory", label: "Memory Management", icon: Layers, el: <MemoryLab /> },
  { path: "disk", label: "Disk Scheduling", icon: HardDrive, el: <DiskLab /> },
  { path: "fs", label: "File Systems", icon: Database, el: <FsLab /> },
  { path: "arch", label: "OS Architecture", icon: Binary, el: <ArchLab /> },
];

export default function AlgorithmLab() {
  return (
    <div className="p-3 flex gap-3 min-w-[1000px] items-start">
      <nav className="panel w-[196px] shrink-0 sticky top-3" aria-label="Algorithm categories">
        <div className="panel-head">Categories</div>
        <ul className="p-1.5 flex flex-col gap-0.5">
          {CATS.map(({ path, label, icon: Icon }) => (
            <li key={path}>
              <NavLink
                to={`/lab/${path}`}
                className={({ isActive }) =>
                  `flex items-center gap-2 h-8 px-2 rounded-sm text-[12.5px] border ${
                    isActive ? "bg-panel-raised border-steel text-ink" : "border-transparent text-ink-2 hover:bg-white/[0.03]"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon size={14} className={isActive ? "text-amber" : "text-ink-3"} />
                    {label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="px-3 pb-3 text-[10.5px] text-ink-3 leading-snug">
          Everything here is <span className="text-violet">simulated</span> by FlowDesk, separately from the live telemetry and real tasks elsewhere in the app.
        </div>
      </nav>
      <div className="flex-1 min-w-0">
        <Routes>
          <Route index element={<Navigate to="cpu" replace />} />
          {CATS.map((c) => (
            <Route key={c.path} path={c.path} element={c.el} />
          ))}
        </Routes>
      </div>
    </div>
  );
}
