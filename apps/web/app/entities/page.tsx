import { BusinessEntityDirectory } from "../../src/business-entities/business-entity-directory";
import { AppShell } from "../../src/layout/app-shell";

export default function BusinessEntitiesPage() {
  return (
    <AppShell activeItem="经营对象" breadcrumb="销售工作台 / 经营对象">
      <div className="page-content directory-page">
        <section className="page-heading">
          <div>
            <p className="eyebrow">BUSINESS ENTITY OPERATIONS</p>
            <h1>当前由谁负责，主商机推进到哪里</h1>
            <p>
              客户、渠道、伙伴与厂商使用同一经营对象视图；责任关系与商机变化保留完整历史。
            </p>
          </div>
          <div className="safety-note">
            <span aria-hidden="true">◎</span>
            租户数据边界已启用
          </div>
        </section>

        <BusinessEntityDirectory />
      </div>
    </AppShell>
  );
}
