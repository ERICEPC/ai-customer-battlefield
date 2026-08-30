import { describe, expect, it } from "vitest";

import { developmentActorConfiguration } from "./development-actor";

describe("development actor configuration", () => {
  it("keeps the visible owner and submitted user on the same configured actor", () => {
    expect(
      developmentActorConfiguration({
        NEXT_PUBLIC_DEV_USER_ID: "30000000-0000-4000-8000-000000000099",
        NEXT_PUBLIC_DEV_USER_DISPLAY_NAME: "销售乙",
      }),
    ).toEqual({
      userId: "30000000-0000-4000-8000-000000000099",
      displayName: "销售乙",
    });
  });
});
