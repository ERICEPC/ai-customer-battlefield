import type { NotificationChannel } from "@battlefield/core";

import {
  FeishuChannel,
  type FeishuCredentialProvider,
  type FeishuCredentials,
} from "./feishu/feishu-channel.js";
import { LarkSdkMessenger } from "./feishu/lark-sdk-messenger.js";

export interface FeishuChannelConfig extends FeishuCredentials {
  publicWebBaseUrl: string;
  receiveIdType: "open_id";
}

export class SingleTenantFeishuCredentialProvider
  implements FeishuCredentialProvider
{
  constructor(
    private readonly tenantId: string,
    private readonly credentials: FeishuCredentials,
  ) {}

  async get(tenantId: string): Promise<FeishuCredentials | null> {
    return tenantId === this.tenantId ? this.credentials : null;
  }
}

export function createNotificationChannels(input: {
  tenantId: string;
  feishu: FeishuChannelConfig | null;
}): NotificationChannel[] {
  if (!input.feishu) {
    return [];
  }
  return [
    new FeishuChannel({
      tenantId: input.tenantId,
      publicWebBaseUrl: input.feishu.publicWebBaseUrl,
      credentialProvider: new SingleTenantFeishuCredentialProvider(
        input.tenantId,
        { appId: input.feishu.appId, appSecret: input.feishu.appSecret },
      ),
      messenger: new LarkSdkMessenger(),
    }),
  ];
}
