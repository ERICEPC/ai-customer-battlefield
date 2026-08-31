"use client";

import type { SessionProfile } from "@battlefield/contracts";
import { type FormEvent, useState } from "react";

import { AuthApiError, login } from "./api-client";
import { useSession } from "./session-provider";

const demoAccounts = [
  { role: "销售1", email: "sales1@demo.local" },
  { role: "领导A", email: "leader.a@demo.local" },
] as const;

export function LoginForm({
  onAuthenticated,
}: {
  onAuthenticated?: (session: SessionProfile) => void;
}) {
  const { setAuthenticatedSession } = useSession();
  const [tenantSlug, setTenantSlug] = useState("alpha");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await login({ tenantSlug, email, password });
      setPassword("");
      setAuthenticatedSession(session);
      if (onAuthenticated) onAuthenticated(session);
      else window.location.assign("/workspace");
    } catch (cause) {
      setPassword("");
      setError(
        cause instanceof AuthApiError
          ? cause.message
          : "登录失败，请检查网络后重试。",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-card">
      <div className="login-heading">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <div>
          <p className="eyebrow">AI CUSTOMER BATTLEFIELD</p>
          <h1>登录客户作战台</h1>
          <p>销售录入经营事实，直属领导查看部门进展。</p>
        </div>
      </div>

      <form onSubmit={submit} className="login-form">
        <label>
          租户
          <input
            name="tenantSlug"
            value={tenantSlug}
            onChange={(event) => setTenantSlug(event.target.value)}
            autoComplete="organization"
          />
        </label>
        <label>
          邮箱
          <input
            name="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "正在登录…" : "登录作战台"}
        </button>
      </form>

      <section className="demo-account-list" aria-label="演示账号">
        <p>演示账号 · 密码 Demo@2026</p>
        {demoAccounts.map((account) => (
          <button
            key={account.email}
            type="button"
            onClick={() => {
              setEmail(account.email);
              setPassword("Demo@2026");
            }}
          >
            <strong>{account.role}</strong>
            <span>{account.email}</span>
          </button>
        ))}
      </section>
    </div>
  );
}
