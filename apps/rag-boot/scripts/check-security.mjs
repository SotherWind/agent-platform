/**
 * CI 安全门禁（清单 TDD 约定第 4 条 / T7.3 的执行层）。
 *
 * 安全类测试（租户隔离、动作确认、Guardrails、跨切面基线）：
 *   - 失败 → 阻断合并（vitest 退出码直接传递）；
 *   - skip / pending → 同样视为失败——「环境不满足就跳过」在安全域
 *     不允许静默通过（sqliteAvailable 这类守卫不能成为安全用例不跑的挡箭牌）。
 *
 * 输出：把测试统计写到 stdout，CI 据此把真实结果喂给 SECURITY_TESTS_PASSED。
 * 本地可直接 `pnpm test:security` 复现 CI 行为。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const reportPath = join(root, "security-report.json");

/** 清单点名的安全域：租户隔离 / 动作确认 / Guardrails（T4.1-T4.3），外加跨切面基线 */
const SECURITY_FILES = [
  "src/__tests__/security.test.ts",
  "src/__tests__/t23-tenant-isolation.test.ts",
  "src/__tests__/t41-input-guardrails.test.ts",
  "src/__tests__/t42-action-guardrails.test.ts",
  "src/__tests__/t43-output-review.test.ts",
  "src/__tests__/t53-proposal.test.ts",
];

let status = 0;
try {
  execFileSync(
    process.execPath,
    [
      vitest,
      "run",
      "--project",
      "unit",
      ...SECURITY_FILES,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    { cwd: root, stdio: "inherit" },
  );
} catch {
  // 有失败用例：vitest 已打印详情，退出码即失败
  status = 1;
}

if (status === 0) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const pending = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  if (pending > 0) {
    console.error(`\n安全类测试出现 ${pending} 个 skip/pending —— 按清单约定视为失败。`);
    status = 1;
  } else {
    console.log(`\n安全类测试 ${report.numPassedTests} 条全部通过，零 skip。`);
  }
}

rmSync(reportPath, { force: true });
process.exit(status);
