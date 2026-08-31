import { FollowupDetailWorkspace } from "../../../src/followups/followup-detail-workspace";
import { AppShell } from "../../../src/layout/app-shell";

export default async function FollowupDetailPage({
  params,
}: {
  params: Promise<{ followupId: string }>;
}) {
  const { followupId } = await params;
  return (
    <AppShell activeItem="经营对象" breadcrumb="销售工作台 / 正式跟进详情">
      <div className="page-content followup-detail-page">
        <section className="page-heading">
          <div>
            <p className="eyebrow">TRACEABLE SALES RECORD</p>
            <h1>每条经营变化，都能回到正式事实</h1>
            <p>
              这里展示人工确认后的原始业务记录；作战地图和领导消息均引用同一条记录。
            </p>
          </div>
          <div className="safety-note">
            <span aria-hidden="true">✓</span>
            已人工确认入库
          </div>
        </section>
        <FollowupDetailWorkspace followupId={followupId} />
      </div>
    </AppShell>
  );
}
