import "@testing-library/jest-dom/vitest";

import type {
  TestUserAiConnectionResponse,
  UpdateUserAiSettingsRequest,
  UserAiSettingsResponse,
} from "@battlefield/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  UserAiSettingsWorkspace,
  type UserAiSettingsWorkspaceApi,
} from "./user-ai-settings-workspace";

const configured: UserAiSettingsResponse = {
  selectedModel: "senseaudio-s2-flash",
  apiKeyConfigured: true,
  apiKeyLastFour: "7890",
  updatedAt: "2026-08-31T12:00:00.000Z",
};

function api(): UserAiSettingsWorkspaceApi {
  return {
    get: vi.fn().mockResolvedValue(configured),
    update: vi.fn(
      async (
        input: UpdateUserAiSettingsRequest,
      ): Promise<UserAiSettingsResponse> => ({
        ...configured,
        selectedModel: input.selectedModel,
        apiKeyLastFour: input.apiKey ? input.apiKey.slice(-4) : "7890",
      }),
    ),
    testConnection: vi.fn().mockResolvedValue({
      ok: true,
      model: "glm-5.3-flash",
      reply: "连接成功",
      providerRequestId: "chatcmpl-real-test",
      durationMs: 438,
    } satisfies TestUserAiConnectionResponse),
  };
}

afterEach(cleanup);

describe("UserAiSettingsWorkspace", () => {
  test("shows all 19 models and saves a personal key without echoing it", async () => {
    const settingsApi = api();
    render(<UserAiSettingsWorkspace api={settingsApi} />);

    expect(await screen.findByText("已配置 · 尾号 7890")).toBeVisible();
    const selector = screen.getByLabelText("默认文本模型");
    expect(within(selector).getAllByRole("option")).toHaveLength(19);
    fireEvent.change(selector, { target: { value: "glm-5.3-flash" } });
    fireEvent.change(screen.getByLabelText("SenseAudio API Key"), {
      target: { value: "sk-new-personal-secret-abcdefghij" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存个人设置" }));

    expect(await screen.findByText("个人 AI 设置已保存")).toBeVisible();
    expect(settingsApi.update).toHaveBeenCalledWith({
      selectedModel: "glm-5.3-flash",
      apiKey: "sk-new-personal-secret-abcdefghij",
    });
    expect(screen.getByLabelText("SenseAudio API Key")).toHaveValue("");
    expect(
      screen.queryByDisplayValue("sk-new-personal-secret-abcdefghij"),
    ).not.toBeInTheDocument();
  });

  test("renders a visible real connection receipt", async () => {
    const settingsApi = api();
    render(<UserAiSettingsWorkspace api={settingsApi} />);
    await screen.findByText("已配置 · 尾号 7890");
    fireEvent.click(screen.getByRole("button", { name: "测试模型连接" }));

    const receipt = await screen.findByRole("status", { name: "模型连接成功" });
    expect(within(receipt).getByText("连接成功")).toBeVisible();
    expect(within(receipt).getByText("chatcmpl-real-test")).toBeVisible();
    expect(within(receipt).getByText("438 ms")).toBeVisible();
  });
});
