// ============================================================
// AMA — App Root with Router
// ============================================================
import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { Toaster } from './components/Toaster';
import { DragDropProvider } from './components/DragDropProvider';
import { ArchitecturePage } from './pages/ArchitecturePage';
import { AssemblyPage } from './pages/AssemblyPage';
import DashboardPage from './pages/DashboardPage';
import { ExportPage } from './pages/ExportPage';
import { GitPage } from './pages/GitPage';
import { ProjectPage } from './pages/ProjectPage';
import { CodebasePage } from './pages/CodebasePage';
import { ReleasePage } from './pages/ReleasePage';
import { RiskPage } from './pages/RiskPage';
import { HardwarePage } from './pages/HardwarePage';
import { useStore } from './lib/store';

// Step 1 is a different page in each workspace
const ProjectRoute: React.FC = () => {
    const kind = useStore(s => s.workspaceKind);
    return kind === 'codebase' ? <CodebasePage /> : <ProjectPage />;
};

// In a machine the blocks can be adjusted (ArchitecturePage shows a notice); the code base is not touched
const ArchitectureRoute: React.FC = () => {
    return <ArchitecturePage />;
};

const App: React.FC = () => {
  return (
    <ErrorBoundary>
    <HashRouter>
      <DragDropProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/project" element={<ProjectRoute />} />
            <Route path="/" element={<ArchitectureRoute />} />
            <Route path="/hardware" element={<HardwarePage />} />
            <Route path="/risk" element={<RiskPage />} />
            <Route path="/release" element={<ReleasePage />} />
            <Route path="/assembly" element={<AssemblyPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/export" element={<ExportPage />} />
            <Route path="/git" element={<GitPage />} />
          </Route>
        </Routes>
        <Toaster />
      </DragDropProvider>
    </HashRouter>
    </ErrorBoundary>
  );
};

export default App;
