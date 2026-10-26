import { lazy, Suspense } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { Sidebar } from "../components/layout/Sidebar";
import { TopStrip } from "../components/layout/TopStrip";
import { Loading } from "../components/industrial/Panel";
import { Overview } from "../pages/Overview";

const LiveMonitor = lazy(() => import("../pages/LiveMonitor"));
const Workspace = lazy(() => import("../pages/Workspace"));
const Observatory = lazy(() => import("../pages/observatory/Observatory"));
const AlgorithmLab = lazy(() => import("../pages/lab/AlgorithmLab"));
const Experiments = lazy(() => import("../pages/Experiments"));
const History = lazy(() => import("../pages/History"));
const Settings = lazy(() => import("../pages/Settings"));

export function App() {
  return (
    <HashRouter>
      <div className="h-full flex">
        <Sidebar />
        <div className="flex-1 min-w-0 flex flex-col">
          <TopStrip />
          <main className="flex-1 min-h-0 overflow-auto grid-floor">
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/" element={<Overview />} />
                <Route path="/monitor" element={<LiveMonitor />} />
                <Route path="/workspace" element={<Workspace />} />
                <Route path="/observatory" element={<Observatory />} />
                <Route path="/lab/*" element={<AlgorithmLab />} />
                <Route path="/experiments" element={<Experiments />} />
                <Route path="/history" element={<History />} />
                <Route path="/settings" element={<Settings />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
    </HashRouter>
  );
}
