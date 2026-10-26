import { Panel } from "../components/industrial/Panel";
import { useEngine } from "../lib/engine/store";
import { ActiveTask } from "./overview/ActiveTask";
import { InstrumentCluster, ThermalPanel } from "./overview/Instruments";
import { focusJob, isFlowing, Pipeline } from "./overview/Pipeline";
import { ResourceCharts } from "./overview/ResourceCharts";
import { CurrentTasks, RecentExperiments } from "./overview/Tables";

export function Overview() {
  const snap = useEngine();
  const job = focusJob(snap);
  return (
    <div className="p-3 flex flex-col gap-3 min-w-[1000px]">
      <div className="grid gap-3 grid-cols-[repeat(4,minmax(0,1fr))_minmax(250px,0.95fr)]">
        <InstrumentCluster />
        <ThermalPanel />
      </div>

      <Panel
        title="Task Execution Engine"
        code="C"
        rivets
        status={
          isFlowing(job)
            ? { tone: "amber", label: "workload flowing", pulse: true }
            : job && (job.status === "queued" || job.status === "paused")
              ? { tone: "info", label: job.status }
              : { tone: "off", label: "idle" }
        }
        actions={<span className="text-[10.5px] text-ink-3">Animation reflects backend-reported progress only</span>}
        bodyClassName="p-2.5"
      >
        <Pipeline />
      </Panel>

      <div className="grid gap-3 grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        <ActiveTask job={job} />
        <ResourceCharts />
      </div>

      <div className="grid gap-3 grid-cols-2">
        <CurrentTasks />
        <RecentExperiments />
      </div>
    </div>
  );
}
