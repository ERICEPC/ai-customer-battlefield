import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const boundaryRules = [
  { name: "internal-artifact-path", target: "path", pattern: /^artifacts\// },
  { name: "internal-findings-path", target: "path", pattern: /^findings\.md$/ },
  { name: "internal-progress-path", target: "path", pattern: /^progress\.md$/ },
  { name: "internal-plan-path", target: "path", pattern: /^task_plan\.md$/ },
  {
    name: "internal-evidence-path",
    target: "path",
    pattern: /^docs\/(design|discovery|research)\//,
  },
  { name: "recording-path", target: "path", pattern: /\.(mp4|mov|m4v)$/i },
  {
    name: "private-collaboration-host",
    target: "content",
    pattern: new RegExp(["sense", "time\\.feishu\\.cn"].join(""), "i"),
  },
  {
    name: "absolute-macos-home-path",
    target: "content",
    pattern: new RegExp(["/", "Users", "/"].join("")),
  },
  {
    name: "recording-reference",
    target: "content",
    pattern: new RegExp(["recording", "\\.mp4"].join(""), "i"),
  },
];

function matchesForEntry({ path, content = "" }) {
  return boundaryRules.filter(({ target, pattern }) =>
    pattern.test(target === "path" ? path : content),
  );
}

export function findPublicBoundaryViolations(entries) {
  return entries.filter((entry) => matchesForEntry(entry).length > 0);
}

function readTrackedTextEntries() {
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

  return trackedFiles.flatMap((path) => {
    if (!existsSync(path)) return [];
    const bytes = readFileSync(path);
    return [
      {
        path,
        content: bytes.includes(0) ? "" : bytes.toString("utf8"),
      },
    ];
  });
}

function run() {
  const entries = readTrackedTextEntries();
  const violations = entries.flatMap((entry) => {
    const ruleNames = matchesForEntry(entry).map(({ name }) => name);
    return ruleNames.length > 0 ? [{ path: entry.path, ruleNames }] : [];
  });

  if (violations.length === 0) {
    console.log(
      `Public boundary check passed (${entries.length} tracked files scanned).`,
    );
    return;
  }

  console.error("Public boundary check failed:");
  for (const { path, ruleNames } of violations) {
    console.error(`- ${path}: ${ruleNames.join(", ")}`);
  }
  process.exitCode = 1;
}

const currentModulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && currentModulePath === resolve(process.argv[1])) {
  run();
}
