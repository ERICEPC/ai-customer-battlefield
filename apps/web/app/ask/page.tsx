import { AppShell } from "../../src/layout/app-shell";
import { ManagementQueryWorkspace } from "../../src/management-queries/management-query-workspace";

export default function ManagementQueryPage() {
  return (
    <AppShell activeItem="管理问数" breadcrumb="销售工作台 / 管理问数">
      <div className="page-content ask-page">
        <ManagementQueryWorkspace />
      </div>
    </AppShell>
  );
}
