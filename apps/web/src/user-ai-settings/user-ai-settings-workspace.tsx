"use client";

import {
  type SenseAudioTextModelId,
  senseAudioTextModelIds,
  type TestUserAiConnectionResponse,
  type UpdateUserAiSettingsRequest,
  type UserAiSettingsResponse,
} from "@battlefield/contracts";
import { type FormEvent, useEffect, useState } from "react";

import {
  getUserAiSettings,
  testUserAiConnection,
  updateUserAiSettings,
} from "./api-client";

export interface UserAiSettingsWorkspaceApi {
  get(): Promise<UserAiSettingsResponse>;
  update(input: UpdateUserAiSettingsRequest): Promise<UserAiSettingsResponse>;
  testConnection(): Promise<TestUserAiConnectionResponse>;
}

const defaultApi: UserAiSettingsWorkspaceApi = {
  get: getUserAiSettings,
  update: updateUserAiSettings,
  testConnection: testUserAiConnection,
};

export function UserAiSettingsWorkspace({
  api = defaultApi,
}: {
  api?: UserAiSettingsWorkspaceApi;
}) {
  const [settings, setSettings] = useState<UserAiSettingsResponse | null>(null);
  const [selectedModel, setSelectedModel] = useState<SenseAudioTextModelId>(
    "senseaudio-s2-flash",
  );
  const [apiKey, setApiKey] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TestUserAiConnectionResponse | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    api
      .get()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setSelectedModel(loaded.selectedModel);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    setMessage(null);
    setError(null);
    setReceipt(null);
    try {
      const next = await api.update({
        selectedModel,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setSettings(next);
      setApiKey("");
      setMessage("个人 AI 设置已保存");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsSaving(false);
    }
  }

  async function testConnection(): Promise<void> {
    if (isTesting) return;
    setIsTesting(true);
    setMessage(null);
    setError(null);
    setReceipt(null);
    try {
      setReceipt(await api.testConnection());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsTesting(false);
    }
  }

  if (isLoading) {
    return (
      <section className="settings-state" role="status">
        <span className="loading-mark" aria-hidden="true" />
        正在读取个人 AI 设置…
      </section>
    );
  }

  return (
    <div className="user-ai-settings-workspace">
      <section className="page-heading settings-heading">
        <div>
          <p className="eyebrow">PERSONAL AI SETTINGS</p>
          <h1>个人设置</h1>
          <p>选择你默认使用的文本模型，并管理个人 SenseAudio API Key。</p>
        </div>
        <div
          className={`key-status ${settings?.apiKeyConfigured ? "configured" : "missing"}`}
        >
          <span aria-hidden="true">
            {settings?.apiKeyConfigured ? "✓" : "!"}
          </span>
          <div>
            <strong>API Key</strong>
            <p>
              {settings?.apiKeyConfigured
                ? `已配置 · 尾号 ${settings.apiKeyLastFour}`
                : "尚未配置"}
            </p>
          </div>
        </div>
      </section>

      <form className="settings-card" onSubmit={(event) => void save(event)}>
        <div className="settings-card-heading">
          <div>
            <span>模型与凭证</span>
            <h2>SenseAudio</h2>
          </div>
          <span className="settings-provider-badge">Chat Completions</span>
        </div>

        <label>
          默认文本模型
          <select
            aria-label="默认文本模型"
            value={selectedModel}
            onChange={(event) =>
              setSelectedModel(
                event.currentTarget.value as SenseAudioTextModelId,
              )
            }
          >
            {senseAudioTextModelIds.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <small>当前官方 Chat 接口可选的 19 个文本模型。</small>
        </label>

        <label>
          SenseAudio API Key
          <input
            aria-label="SenseAudio API Key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder={
              settings?.apiKeyConfigured
                ? `已保存 · 尾号 ${settings.apiKeyLastFour}；留空则不更换`
                : "请输入 sk- 开头的 API Key"
            }
            autoComplete="off"
          />
          <small>保存后只显示配置状态和后四位。</small>
        </label>

        {message ? <p className="settings-success">{message}</p> : null}
        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="settings-actions">
          <button type="submit" className="primary-button" disabled={isSaving}>
            {isSaving ? "正在保存…" : "保存个人设置"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={isTesting || !settings?.apiKeyConfigured}
            onClick={() => void testConnection()}
          >
            {isTesting ? "正在连接模型…" : "测试模型连接"}
          </button>
        </div>
      </form>

      {receipt ? (
        <section
          className="settings-test-receipt"
          role="status"
          aria-label="模型连接成功"
        >
          <span className="settings-receipt-mark" aria-hidden="true">
            ✓
          </span>
          <div>
            <strong>模型连接成功</strong>
            <p>{receipt.reply}</p>
          </div>
          <dl>
            <div>
              <dt>模型</dt>
              <dd>{receipt.model}</dd>
            </div>
            <div>
              <dt>请求编号</dt>
              <dd>{receipt.providerRequestId ?? "未返回"}</dd>
            </div>
            <div>
              <dt>响应耗时</dt>
              <dd>{receipt.durationMs} ms</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "个人 AI 设置操作失败。";
}
