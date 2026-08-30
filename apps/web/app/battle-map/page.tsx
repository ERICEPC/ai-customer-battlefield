import { BattleMapWorkspace } from "../../src/battle-operations/battle-map-workspace";
import { AppShell } from "../../src/layout/app-shell";

export default async function BattleMapPage({
  searchParams,
}: {
  searchParams: Promise<{ entityId?: string; stateVersion?: string }>;
}) {
  const source = await searchParams;
  return (
    <AppShell activeItem="客户作战地图" breadcrumb="管理视角 / 客户作战地图">
      <div className="page-content battle-page">
        <section className="page-heading battle-page-heading">
          <div>
            <p className="eyebrow">CUSTOMER BATTLEFIELD</p>
            <h1>先看位置，再看依据，最后决定介入</h1>
            <p>
              关系深度与规模潜力只由已确认事实计算。每个点位都能回到分析版本、证据事实与判断信号。
            </p>
          </div>
          <div className="safety-note">
            <span aria-hidden="true">◇</span>
            数据不足不强行定位
          </div>
        </section>
        <BattleMapWorkspace
          initialEntityId={source.entityId}
          sourceStateVersionId={source.stateVersion}
        />
      </div>
    </AppShell>
  );
}
