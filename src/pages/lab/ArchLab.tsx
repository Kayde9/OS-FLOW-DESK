import { useState } from "react";
import { Panel, Seg, SimBadge } from "../../components/industrial/Panel";

const LAYERS = [
  { id: "app", name: "User applications", ring: "Ring 3 · user mode", items: ["FlowDesk (Tauri / WebView2)", "Explorer", "Services"], note: "Unprivileged code; requests OS services through system calls." },
  { id: "sub", name: "Subsystem DLLs", ring: "Ring 3", items: ["kernel32.dll / KernelBase.dll", "user32.dll", "ntdll.dll (syscall stubs)"], note: "Win32 APIs translate to native NT calls; ntdll executes the syscall instruction." },
  { id: "exec", name: "Executive", ring: "Ring 0 · kernel mode", items: ["I/O manager", "Memory manager", "Process & thread manager", "Object manager", "Security reference monitor", "Cache manager"], note: "Policy and services: handles, virtual memory, I/O request packets (IRPs)." },
  { id: "kern", name: "Kernel", ring: "Ring 0", items: ["Thread dispatcher (scheduler)", "Interrupt & DPC handling", "Synchronisation primitives"], note: "Mechanism: it schedules threads onto CPUs. This is the scheduler FlowDesk never replaces." },
  { id: "drv", name: "Drivers", ring: "Ring 0", items: ["File system (NTFS)", "Volume / disk class drivers", "GPU (WDDM) driver"], note: "Layered driver stacks receive IRPs from the I/O manager." },
  { id: "hal", name: "HAL & hardware", ring: "Hardware", items: ["Hardware Abstraction Layer", "CPU · RAM · NVMe · GPU"], note: "The HAL hides platform differences such as interrupt controllers and timers." },
];

const TRACES: Record<string, { title: string; steps: [string, string][] }> = {
  hash: {
    title: "FlowDesk hashes one file chunk",
    steps: [
      ["app", "Worker thread calls std::fs::File::read (Rust) on a 256 KiB buffer"],
      ["sub", "KernelBase!ReadFile → ntdll!NtReadFile → syscall instruction (switch to kernel mode)"],
      ["exec", "I/O manager validates the handle via the object manager, builds an IRP_MJ_READ"],
      ["exec", "Cache manager: if the data is in the system file cache, copy it and complete immediately"],
      ["drv", "Otherwise NTFS maps file offset → disk clusters and passes the IRP to the volume/disk stack"],
      ["hal", "The NVMe controller DMAs the data to RAM and raises an interrupt"],
      ["kern", "ISR → DPC completes the IRP; the dispatcher readies the waiting worker thread"],
      ["app", "Thread resumes in user mode; SHA-256 runs on the buffer (pure CPU, no syscalls)"],
    ],
  },
  telemetry: {
    title: "FlowDesk reads disk counters (PDH)",
    steps: [
      ["app", "Telemetry thread calls PdhCollectQueryData once per interval"],
      ["sub", "pdh.dll queries registered performance providers"],
      ["exec", "Kernel-maintained per-disk counters are read; no disk I/O is performed"],
      ["app", "Rates are computed from two consecutive raw samples (hence the 'warming up' state)"],
    ],
  },
  sched: {
    title: "A FlowDesk worker is preempted",
    steps: [
      ["hal", "The timer interrupt fires on a CPU"],
      ["kern", "The dispatcher finds that the worker's OS quantum has expired and a ready thread of equal or higher priority exists"],
      ["kern", "Context switch: save the worker's registers in its KTHREAD and load the next thread"],
      ["app", "FlowDesk is unaware. Its own Round Robin quantum works independently, at the level of tasks and files."],
    ],
  },
};

const MODELS = [
  { name: "Monolithic", eg: "Linux, classic UNIX", pro: "Fast: services call each other directly in kernel space", con: "A bug in any driver can crash the whole kernel" },
  { name: "Microkernel", eg: "MINIX 3, seL4, QNX", pro: "Isolation: drivers and servers run as user processes", con: "IPC overhead on every service request" },
  { name: "Hybrid", eg: "Windows NT, macOS XNU", pro: "Microkernel-style structure with performance-critical parts in kernel mode", con: "Most services still share one address space" },
  { name: "Layered", eg: "THE, MULTICS (rings)", pro: "Each layer uses only the layer beneath it, so it is easy to verify", con: "Strict layering is hard to define and adds overhead" },
];

export default function ArchLab() {
  const [trace, setTrace] = useState<keyof typeof TRACES>("hash");
  const [i, setI] = useState(0);
  const t = TRACES[trace];
  const active = t.steps[i]?.[0];
  return (
    <div className="flex flex-col gap-3">
      <Panel title="Windows NT architecture" code="A1" actions={<span className="sim-badge">Conceptual model</span>}>
        <div className="grid grid-cols-[1fr_380px] gap-4">
          <div className="flex flex-col gap-1">
            {LAYERS.map((l, k) => (
              <div key={l.id}>
                {k === 2 && <div className="flex items-center gap-2 my-1"><div className="flex-1 border-t border-dashed border-amber/60" /><span className="text-micro uppercase text-amber">user / kernel boundary · syscall</span><div className="flex-1 border-t border-dashed border-amber/60" /></div>}
                <div className={`rounded-sm border px-3 py-2 transition-colors duration-200 ${active === l.id ? "border-amber bg-amber/[0.08]" : "border-steel-dim bg-panel-sunk"}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12.5px] font-medium">{l.name}</span>
                    <span className="text-micro uppercase text-ink-3">{l.ring}</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {l.items.map((it) => <span key={it} className="text-[11px] px-1.5 py-0.5 rounded-sm bg-panel-raised text-ink-2 border border-steel-dim">{it}</span>)}
                  </div>
                  <div className="text-[10.5px] text-ink-3 mt-1">{l.note}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <Seg label="Trace" value={trace} onChange={(v) => (setTrace(v), setI(0))} options={[{ value: "hash", label: "File read" }, { value: "telemetry", label: "Counters" }, { value: "sched", label: "Preemption" }]} />
            <div className="text-[12.5px] font-medium">{t.title}</div>
            <ol className="flex flex-col gap-1">
              {t.steps.map(([layer, text], k) => (
                <li key={k}>
                  <button className={`w-full text-left text-[11.5px] px-2 py-1.5 rounded-sm border ${k === i ? "border-amber/70 bg-amber/[0.07] text-ink" : "border-steel-dim text-ink-2 hover:border-steel"}`} onClick={() => setI(k)}>
                    <span className="readout text-ink-3 mr-1.5">{k + 1}</span>
                    {text}
                    <span className="block text-micro uppercase text-ink-3 mt-0.5">{LAYERS.find((l) => l.id === layer)?.name}</span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="flex gap-1.5">
              <button className="btn btn-sm" disabled={i === 0} onClick={() => setI(i - 1)}>Previous</button>
              <button className="btn btn-sm btn-amber" disabled={i >= t.steps.length - 1} onClick={() => setI(i + 1)}>Next</button>
            </div>
            <p className="text-[10.5px] text-ink-3">Simplified for teaching. Real paths involve filter drivers, fast I/O and asynchronous completion.</p>
          </div>
        </div>
      </Panel>
      <Panel title="Kernel structures compared" code="A2" actions={<SimBadge>Reference</SimBadge>}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Model</th>
              <th>Examples</th>
              <th>Strength</th>
              <th>Trade-off</th>
            </tr>
          </thead>
          <tbody>
            {MODELS.map((m) => (
              <tr key={m.name}>
                <td className="font-medium">{m.name}</td>
                <td className="text-ink-2">{m.eg}</td>
                <td className="text-ink-2 whitespace-normal">{m.pro}</td>
                <td className="text-ink-2 whitespace-normal">{m.con}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
