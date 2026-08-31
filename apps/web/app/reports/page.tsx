import { AppShell } from "../../src/layout/app-shell";
import { WeeklyReportWorkspace } from "../../src/weekly-reports/weekly-report-workspace";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ reportId?: string; versionId?: string }>;
}) {
  const { versionId } = await searchParams;
  return (
    <AppShell activeItem="周报中心" breadcrumb="销售工作台 / 周报中心">
      <div className="page-content report-page">
        <section className="page-heading report-page-heading">
          <div>
            <p className="eyebrow">WEEKLY FIELD REPORT</p>
            <h1>把一周经营事实，冻结成可审阅的战报</h1>
            <p>
              个人周报与管理范围周报共用正式事实口径。来源内容不可改写，审阅只决定是否纳入，发布后通过新版本修订。
            </p>
          </div>
          <div className="report-boundary-note">
            <span aria-hidden="true">▣</span>
            发布版本不可覆盖
          </div>
        </section>
        <WeeklyReportWorkspace
          {...(versionId ? { initialVersionId: versionId } : {})}
        />
      </div>
    </AppShell>
  );
}
