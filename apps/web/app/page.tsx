import { FollowupDraftForm } from "../src/followup-drafts/followup-draft-form";
import { AppShell } from "../src/layout/app-shell";

export default function HomePage() {
  return (
    <AppShell activeItem="跟进工作台" breadcrumb="销售工作台 / 跟进">
      <div className="page-content" id="followup-workbench">
        <section className="page-heading">
          <div>
            <p className="eyebrow">FOLLOW-UP WORKBENCH</p>
            <h1>把每次沟通，沉淀为下一步行动</h1>
            <p>
              AI
              负责整理与建议，你负责确认。所有正式经营事实都保留来源和人工确认边界。
            </p>
          </div>
          <div className="safety-note">
            <span aria-hidden="true">✓</span>
            AI 不直接写入正式记录
          </div>
        </section>

        <FollowupDraftForm />
      </div>
    </AppShell>
  );
}
