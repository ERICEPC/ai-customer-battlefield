import { AppShell } from "../../src/layout/app-shell";
import { WorkspaceDashboard } from "../../src/workspace/workspace-dashboard";

export default function WorkspacePage() {
  return (
    <AppShell activeItem="经营总览" breadcrumb="销售工作台 / 经营总览">
      <div className="page-content workspace-page">
        <WorkspaceDashboard />
      </div>
    </AppShell>
  );
}
