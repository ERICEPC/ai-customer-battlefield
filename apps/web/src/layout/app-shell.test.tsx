import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppShell } from "./app-shell";

afterEach(cleanup);

describe("AppShell", () => {
  it("exposes real desktop and mobile routes for the implemented workspaces", () => {
    render(
      <AppShell activeItem="经营动作" breadcrumb="销售工作台 / 经营动作">
        <p>页面内容</p>
      </AppShell>,
    );

    const desktop = screen.getByRole("navigation", { name: "主导航" });
    expect(
      within(desktop).getByRole("link", { name: "客户作战地图" }),
    ).toHaveAttribute("href", "/battle-map");
    expect(
      within(desktop).getByRole("link", { name: "经营动作" }),
    ).toHaveAttribute("aria-current", "page");

    const mobile = screen.getByRole("navigation", { name: "移动端主导航" });
    expect(within(mobile).getByRole("link", { name: "地图" })).toHaveAttribute(
      "href",
      "/battle-map",
    );
    expect(within(mobile).getByRole("link", { name: "动作" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
