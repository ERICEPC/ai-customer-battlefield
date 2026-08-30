import { ActionWorkspace } from "../../src/battle-operations/action-workspace";
import { AppShell } from "../../src/layout/app-shell";

export default function ActionsPage() {
  return (
    <AppShell activeItem="经营动作" breadcrumb="销售工作台 / 经营动作">
      <div className="page-content battle-page">
        <section className="page-heading battle-page-heading">
          <div>
            <p className="eyebrow">ACTION DECISION CENTER</p>
            <h1>建议要判断，行动要负责</h1>
            <p>
              AI
              建议先进入人工决策门。明确责任人、计划时间和优先级后，才创建可追溯的正式经营动作。
            </p>
          </div>
          <div className="safety-note warning-note">
            <span aria-hidden="true">!</span>
            未确认建议不触发提醒
          </div>
        </section>
        <ActionWorkspace />
      </div>
    </AppShell>
  );
}
