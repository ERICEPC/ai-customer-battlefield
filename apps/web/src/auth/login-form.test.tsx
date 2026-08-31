import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as authApi from "./api-client";
import { LoginForm } from "./login-form";
import { SessionProvider } from "./session-provider";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LoginForm", () => {
  it("shows the two visible demo identities", () => {
    render(
      <SessionProvider initialSession={null}>
        <LoginForm />
      </SessionProvider>,
    );

    expect(screen.getByText("销售1")).toBeVisible();
    expect(screen.getByText("sales1@demo.local")).toBeVisible();
    expect(screen.getByText("领导A")).toBeVisible();
    expect(screen.getByText("leader.a@demo.local")).toBeVisible();
  });

  it("authenticates and hands the visible session to the shell", async () => {
    const session = {
      user: {
        id: "30000000-0000-4000-8000-000000000001",
        displayName: "销售1",
        email: "sales1@demo.local",
      },
      role: "sales" as const,
      department: {
        id: "31000000-0000-4000-8000-000000000001",
        name: "商业化一部",
      },
      directLeader: {
        id: "30000000-0000-4000-8000-000000000072",
        displayName: "领导A",
      },
      teamMembers: [],
      expiresAt: "2026-09-01T08:00:00.000Z",
    };
    vi.spyOn(authApi, "login").mockResolvedValue(session);
    const onAuthenticated = vi.fn();
    render(
      <SessionProvider initialSession={null}>
        <LoginForm onAuthenticated={onAuthenticated} />
      </SessionProvider>,
    );

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "sales1@demo.local" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "Demo@2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录作战台" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(session));
    expect(authApi.login).toHaveBeenCalledWith({
      tenantSlug: "alpha",
      email: "sales1@demo.local",
      password: "Demo@2026",
    });
  });
});
