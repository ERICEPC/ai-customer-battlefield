import { FollowupDraftForm } from "../src/followup-drafts/followup-draft-form";

const navigation = [
  "经营总览",
  "客户作战地图",
  "跟进工作台",
  "经营动作",
  "周报中心",
];

export default function HomePage() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <div>
            <strong>AI 作战台</strong>
            <span>Customer Battlefield</span>
          </div>
        </div>

        <nav aria-label="主导航">
          {navigation.map((item) => (
            <a
              href={item === "跟进工作台" ? "#followup-workbench" : "#"}
              className={item === "跟进工作台" ? "active" : undefined}
              aria-current={item === "跟进工作台" ? "page" : undefined}
              key={item}
            >
              <span className="nav-dot" aria-hidden="true" />
              {item}
            </a>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="environment-dot" />
          演示环境 · 合成数据
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <span className="breadcrumb">销售工作台 / 跟进</span>
          </div>
          <div className="user-chip">
            <span aria-hidden="true">演</span>
            演示销售
          </div>
        </header>

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
      </main>
    </div>
  );
}
