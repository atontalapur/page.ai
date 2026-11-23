import { BrowserRouter, Routes, Route } from 'react-router-dom';

import DashboardLayout from '../components/layout/DashboardLayout';
import DashboardPage from '../pages/DashboardPage';
import IncidentsPage from '../pages/IncidentsPage';
import IncidentDetailsPage from '../pages/IncidentDetailsPage';
import DebuggingPage from '../pages/DebuggingPage';
import KnowledgePage from '../pages/KnowledgePage';
import AgentsPage from '../pages/AgentsPage';
import AgentWorkspacePage from '../pages/AgentWorkspacePage';
import { IssuesProvider } from '../context/IssuesContext';

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="space-y-2">
      <h2 className="text-2xl font-bold">{title}</h2>
      <p className="text-muted-foreground">This page is under development.</p>
    </div>
  );
}

export default function App() {
  return (
    <IssuesProvider>
      <BrowserRouter>
        <DashboardLayout>
          <Routes>
            <Route path="/" element={<DashboardPage />} />

            <Route path="/incidents" element={<IncidentsPage />} />

            <Route path="/incidents/:id" element={<IncidentDetailsPage />} />

            <Route path="/agents" element={<AgentsPage />} />

            <Route path="/agents/:id" element={<AgentWorkspacePage />} />

            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/debug" element={<DebuggingPage />} />

            <Route path="*" element={<PlaceholderPage title="Page Not Found" />} />
          </Routes>
        </DashboardLayout>
      </BrowserRouter>
    </IssuesProvider>
  );
}
