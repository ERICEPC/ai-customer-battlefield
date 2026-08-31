import { AppShell } from "../../src/layout/app-shell";
import { InboxWorkspace } from "../../src/notifications/inbox-workspace";

export default function InboxPage() {
  return (
    <AppShell activeItem="通知中心" breadcrumb="销售工作台 / 通知中心">
      <div className="page-content battle-page inbox-page">
        <section className="page-heading battle-page-heading">
          <div>
            <p className="eyebrow">DURABLE INBOX</p>
            <h1>通知留在系统里，动作回到业务里</h1>
            <p>
              站内通知是可追溯的事实源。外部渠道只负责送达，不影响动作状态、未读记录和业务深链。
            </p>
          </div>
          <div className="safety-note">
            <span aria-hidden="true">✓</span>
            每条通知均可追溯
          </div>
        </section>
        <InboxWorkspace />
      </div>
    </AppShell>
  );
}
