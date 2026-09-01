import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, test, vi } from "vitest";

const poolState = vi.hoisted(() => ({ current: null as EventEmitter | null }));

vi.mock("pg", () => ({
  Pool: class FakePool extends EventEmitter {
    constructor() {
      super();
      poolState.current = this;
    }

    async end() {}
  },
}));

import { createPostgresDatabase } from "../src/database-factory.js";

describe("createPostgresDatabase", () => {
  beforeEach(() => {
    poolState.current = null;
  });

  test("handles idle client errors through the configured observer", async () => {
    const onPoolError = vi.fn();
    const database = createPostgresDatabase(
      "postgresql://synthetic.invalid/battlefield",
      { onPoolError },
    );
    const pool = poolState.current;
    expect(pool).not.toBeNull();
    const error = new Error("synthetic idle connection loss");

    pool?.emit("error", error);

    expect(onPoolError).toHaveBeenCalledWith(error);
    await database.close();
  });

  test("still installs an error listener when no observer is configured", async () => {
    const database = createPostgresDatabase(
      "postgresql://synthetic.invalid/battlefield",
    );
    const pool = poolState.current;

    expect(pool?.listenerCount("error")).toBe(1);
    expect(() =>
      pool?.emit("error", new Error("synthetic loss")),
    ).not.toThrow();
    await database.close();
  });
});
