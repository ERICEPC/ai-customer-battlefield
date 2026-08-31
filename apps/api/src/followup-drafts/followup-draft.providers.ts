import { randomUUID } from "node:crypto";
import {
  CancelFollowupDraft,
  ConfirmFollowupDraft,
  CreatePersistentFollowupDraft,
  type FollowupConfirmationStore,
  type FollowupDraftAgent,
  GetFollowupAutomationStatus,
  GetFollowupDraft,
  GetFormalFollowup,
  ReviseFollowupDraft,
} from "@battlefield/core";
import { KyselyFollowupConfirmationStore } from "@battlefield/database";
import { type Provider, ServiceUnavailableException } from "@nestjs/common";

import type { ApplicationDatabaseHandle } from "../database/database.module.js";
import { DATABASE_HANDLE } from "../database/database.module.js";
import {
  type ApplicationUserAiSettingsService,
  USER_AI_SETTINGS_SERVICE,
} from "../user-ai-settings/user-ai-settings.providers.js";
import { UserAiSettingsError } from "../user-ai-settings/user-ai-settings.service.js";
import { DeterministicFollowupDraftAgent } from "./deterministic-followup-draft-agent.js";
import {
  SenseAudioFollowupDraftAgent,
  SenseAudioFollowupDraftAgentError,
} from "./senseaudio-followup-draft-agent.js";

export const FOLLOWUP_DRAFT_AGENT = Symbol("FOLLOWUP_DRAFT_AGENT");
export const FOLLOWUP_CONFIRMATION_STORE = Symbol(
  "FOLLOWUP_CONFIRMATION_STORE",
);
export const CREATE_FOLLOWUP_DRAFT = Symbol("CREATE_FOLLOWUP_DRAFT");
export const GET_FOLLOWUP_DRAFT = Symbol("GET_FOLLOWUP_DRAFT");
export const REVISE_FOLLOWUP_DRAFT = Symbol("REVISE_FOLLOWUP_DRAFT");
export const CANCEL_FOLLOWUP_DRAFT = Symbol("CANCEL_FOLLOWUP_DRAFT");
export const CONFIRM_FOLLOWUP_DRAFT = Symbol("CONFIRM_FOLLOWUP_DRAFT");
export const GET_FORMAL_FOLLOWUP = Symbol("GET_FORMAL_FOLLOWUP");
export const GET_FOLLOWUP_AUTOMATION_STATUS = Symbol(
  "GET_FOLLOWUP_AUTOMATION_STATUS",
);

const unavailableStore: FollowupConfirmationStore = {
  create: unavailable,
  get: unavailable,
  revise: unavailable,
  cancel: unavailable,
  confirm: unavailable,
  getFollowup: unavailable,
};

async function unavailable(): Promise<never> {
  throw new ServiceUnavailableException(
    "Follow-up persistence is not configured.",
  );
}

class UnavailableFollowupDraftAgent implements FollowupDraftAgent {
  async propose(): Promise<never> {
    throw new SenseAudioFollowupDraftAgentError(
      "not_configured",
      "SenseAudio API key is not configured.",
    );
  }
}

export function createConfiguredFollowupDraftAgent(
  environment: NodeJS.ProcessEnv,
): FollowupDraftAgent {
  const provider =
    environment.FOLLOWUP_AGENT_PROVIDER?.trim() ||
    (environment.NODE_ENV === "test" ? "deterministic" : "senseaudio");
  if (provider === "deterministic" && environment.NODE_ENV !== "production") {
    return new DeterministicFollowupDraftAgent();
  }
  if (provider !== "senseaudio") {
    return new UnavailableFollowupDraftAgent();
  }

  const apiKey = environment.SENSEAUDIO_API_KEY?.trim();
  if (!apiKey) return new UnavailableFollowupDraftAgent();
  return createSenseAudioAgent(environment, {
    apiKey,
    ...(environment.FOLLOWUP_AGENT_MODEL?.trim()
      ? { model: environment.FOLLOWUP_AGENT_MODEL.trim() }
      : {}),
  });
}

export function createUserConfiguredFollowupDraftAgent(
  settings: ApplicationUserAiSettingsService,
  environment: NodeJS.ProcessEnv,
): FollowupDraftAgent {
  const fallback = createConfiguredFollowupDraftAgent(environment);
  if (
    !settings ||
    environment.FOLLOWUP_AGENT_PROVIDER?.trim() === "deterministic"
  ) {
    return fallback;
  }
  return {
    async propose(input) {
      try {
        const credential = await settings.resolveCredential(input.actor);
        return createSenseAudioAgent(environment, credential).propose(input);
      } catch (error) {
        if (
          error instanceof UserAiSettingsError &&
          error.code === "AI_KEY_NOT_CONFIGURED"
        ) {
          return fallback.propose(input);
        }
        if (error instanceof SenseAudioFollowupDraftAgentError) throw error;
        throw new SenseAudioFollowupDraftAgentError(
          "not_configured",
          "The personal SenseAudio credential could not be resolved.",
        );
      }
    },
  };
}

function createSenseAudioAgent(
  environment: NodeJS.ProcessEnv,
  credential: { apiKey: string; model?: string },
): FollowupDraftAgent {
  const timeoutMs = boundedInteger(
    environment.FOLLOWUP_AGENT_TIMEOUT_MS,
    1_000,
    60_000,
  );
  const maxAttempts = boundedInteger(
    environment.FOLLOWUP_AGENT_MAX_ATTEMPTS,
    1,
    3,
  );

  return new SenseAudioFollowupDraftAgent({
    apiKey: credential.apiKey,
    ...(environment.SENSEAUDIO_BASE_URL?.trim()
      ? { baseUrl: environment.SENSEAUDIO_BASE_URL.trim() }
      : {}),
    ...(credential.model?.trim() ? { model: credential.model.trim() } : {}),
    ...(environment.FOLLOWUP_AGENT_PROMPT?.trim()
      ? { prompt: environment.FOLLOWUP_AGENT_PROMPT.trim() }
      : {}),
    ...(environment.FOLLOWUP_AGENT_PROMPT_VERSION?.trim()
      ? { promptVersion: environment.FOLLOWUP_AGENT_PROMPT_VERSION.trim() }
      : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
}

function boundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

export const followupDraftProviders: Provider[] = [
  {
    provide: FOLLOWUP_DRAFT_AGENT,
    inject: [USER_AI_SETTINGS_SERVICE],
    useFactory: (
      settings: ApplicationUserAiSettingsService,
    ): FollowupDraftAgent =>
      createUserConfiguredFollowupDraftAgent(settings, process.env),
  },
  {
    provide: FOLLOWUP_CONFIRMATION_STORE,
    inject: [DATABASE_HANDLE],
    useFactory: (
      database: ApplicationDatabaseHandle,
    ): FollowupConfirmationStore =>
      database
        ? new KyselyFollowupConfirmationStore(database.db)
        : unavailableStore,
  },
  {
    provide: CREATE_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_DRAFT_AGENT, FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (agent: FollowupDraftAgent, store: FollowupConfirmationStore) =>
      new CreatePersistentFollowupDraft({
        agent,
        store,
        idGenerator: { next: () => randomUUID() },
        clock: { now: () => new Date() },
      }),
  },
  {
    provide: GET_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (store: FollowupConfirmationStore) =>
      new GetFollowupDraft(store),
  },
  {
    provide: REVISE_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (store: FollowupConfirmationStore) =>
      new ReviseFollowupDraft(store),
  },
  {
    provide: CANCEL_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (store: FollowupConfirmationStore) =>
      new CancelFollowupDraft(store),
  },
  {
    provide: CONFIRM_FOLLOWUP_DRAFT,
    inject: [FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (store: FollowupConfirmationStore) =>
      new ConfirmFollowupDraft(store),
  },
  {
    provide: GET_FORMAL_FOLLOWUP,
    inject: [FOLLOWUP_CONFIRMATION_STORE],
    useFactory: (store: FollowupConfirmationStore) =>
      new GetFormalFollowup(store),
  },
  {
    provide: GET_FOLLOWUP_AUTOMATION_STATUS,
    inject: [DATABASE_HANDLE],
    useFactory: (database: ApplicationDatabaseHandle) =>
      new GetFollowupAutomationStatus({
        getAutomationStatus: database
          ? (input) =>
              new KyselyFollowupConfirmationStore(
                database.db,
              ).getAutomationStatus(input)
          : unavailable,
      }),
  },
];
