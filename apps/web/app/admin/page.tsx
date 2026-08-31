import { AppShell } from "../../src/layout/app-shell";
import { SystemManagementWorkspace } from "../../src/system-management/system-management-workspace";

export default function AdminPage() {
  return (
    <AppShell activeItem="系统管理" breadcrumb="管理工作台 / 系统管理">
      <div className="page-content admin-page">
        <SystemManagementWorkspace />
      </div>
    </AppShell>
  );
}
