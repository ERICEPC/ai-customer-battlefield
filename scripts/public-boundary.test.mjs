import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { findPublicBoundaryViolations } from "./public-boundary.mjs";

test("reports private paths and sensitive content before they can be published", () => {
  const privateCollaborationHost = ["sense", "time", ".feishu", ".cn"].join("");
  const localHomePath = [
    "/",
    "Users",
    "/",
    "example",
    "/private-notes.md",
  ].join("");
  const recordingName = ["recording", ".mp4"].join("");

  const entries = [
    { path: "README.md", content: "Public project overview" },
    { path: "artifacts/demo/frame.png", content: "" },
    { path: "findings.md", content: "Internal research" },
    { path: "progress.md", content: "Internal status" },
    { path: "task_plan.md", content: "Internal execution plan" },
    { path: "docs/design/private.md", content: "Internal design evidence" },
    { path: "docs/discovery/notes.md", content: "Discovery notes" },
    { path: "docs/research/source.md", content: "Research notes" },
    { path: "captures/customer.mov", content: "" },
    {
      path: "docs/reference.md",
      content: `Source: https://${privateCollaborationHost}/wiki/example`,
    },
    { path: "docs/local.md", content: `Read ${localHomePath}` },
    { path: "docs/media.md", content: `Do not publish ${recordingName}` },
  ];

  assert.deepEqual(
    findPublicBoundaryViolations(entries).map(({ path }) => path),
    entries.slice(1).map(({ path }) => path),
  );
});

test("allows approved public project documents", () => {
  const entries = [
    { path: "CONTEXT.md", content: "Generic domain language" },
    { path: "docs/01-V1-product.md", content: "Public product scope" },
    { path: "docs/02-data-model.md", content: "Public conceptual model" },
    { path: "docs/README.md", content: "Public document index" },
    {
      path: "docs/superpowers/plans/foundation.md",
      content: "Public implementation plan",
    },
  ];

  assert.deepEqual(findPublicBoundaryViolations(entries), []);
});

test("the public CI workflow runs every repository quality gate", () => {
  const workflowPath = ".github/workflows/ci.yml";
  assert.equal(existsSync(workflowPath), true, "the CI workflow must exist");

  const workflow = readFileSync(workflowPath, "utf8");
  const requiredCommands = [
    "pnpm check:public",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm build",
  ];

  for (const command of requiredCommands) {
    assert.match(
      workflow,
      new RegExp(`run: ${command.replace(":", "\\:")}(?:\\n|$)`),
    );
  }
});
