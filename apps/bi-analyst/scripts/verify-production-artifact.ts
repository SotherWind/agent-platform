import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);

const forbiddenPathPatterns = [
  /\.env$/,
  /ecommerce\.db$/,
  /(^|\/)tests\//,
  /(^|\/)fixtures\//,
];

function walk(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function main() {
  const files = walk(distDir);
  if (files.length === 0) {
    console.error("verify:artifact 失败：dist/ 为空，请先执行 pnpm build");
    process.exit(1);
  }

  const violations: string[] = [];
  for (const file of files) {
    const rel = path.relative(distDir, file).replace(/\\/g, "/");
    for (const pattern of forbiddenPathPatterns) {
      if (pattern.test(rel)) {
        violations.push(`${rel} matched ${pattern}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error("verify:artifact 失败：");
    for (const item of violations) console.error(`  - ${item}`);
    process.exit(1);
  }

  console.log(`verify:artifact 通过（${files.length} 个文件）`);
}

main();
