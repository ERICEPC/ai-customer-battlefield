import { AppShell } from "../../src/layout/app-shell";
import { UserAiSettingsWorkspace } from "../../src/user-ai-settings/user-ai-settings-workspace";

export default function SettingsPage() {
  return (
    <AppShell activeItem="个人设置" breadcrumb="个人中心 / AI 设置">
      <div className="page-content settings-page">
        <UserAiSettingsWorkspace />
      </div>
    </AppShell>
  );
}
