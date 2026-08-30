import { describe, expect, it } from "vitest";

import {
  instantToLocalDateTimeInput,
  localDateTimeInputToInstant,
} from "./date-time";

describe("date-time form conversion", () => {
  it("round-trips an instant through an Asia/Shanghai local input", () => {
    const local = instantToLocalDateTimeInput("2026-09-03T09:00:00.000Z", -480);

    expect(local).toBe("2026-09-03T17:00");
    expect(localDateTimeInputToInstant(local, -480)).toBe(
      "2026-09-03T09:00:00.000Z",
    );
  });
});
