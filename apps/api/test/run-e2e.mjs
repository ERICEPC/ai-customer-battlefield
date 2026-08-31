import { spawn } from "node:child_process";

const testFiles = [
  "test/app.e2e.test.ts",
  "test/business-entities.e2e.test.ts",
  "test/followup-confirmation.e2e.test.ts",
  "test/battle-analyzer-failure.e2e.test.ts",
  "test/battle-actions.e2e.test.ts",
  "test/notifications.e2e.test.ts",
  "test/workspace.e2e.test.ts",
  "test/management-queries.e2e.test.ts",
  "test/weekly-reports.e2e.test.ts",
];

for (const testFile of testFiles) {
  const exitCode = await runTestFile(testFile);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    break;
  }
}

function runTestFile(testFile) {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["exec", "vitest", "run", testFile, "--reporter=dot"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${testFile} stopped by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
