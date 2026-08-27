import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultDistDir = path.resolve(path.dirname(scriptPath), "../dist");

const forbiddenPaths = [
  /(^|\/)\.env$/i,
  /ecommerce\.db$/i,
  /(^|\/)tests?\//i,
  /(^|\/)fixtures?\//i,
  /(^|\/)dev-main\.js$/i,
  /(^|\/)bootstrap\/(index|local-profile|staging-e2e-profile)\.js$/i,
  /(^|\/)db\/seed\.js$/i,
  /(^|\/)evaluation\//i,
  /(^|\/)metadata\/demo-documents\.js$/i,
  /(^|\/)runtime\/local-fallback\.js$/i,
];

const forbiddenContent = [
  /\bcreateTestPrincipal\b/,
  /\bcreateTestJwtFixture\b/,
  /["']user-test["']/,
  /test-key-1/,
  /\bDEMO_SCHEMA_DOCUMENTS\b/,
  /\bcreateDemoRetriever\b/,
  /(?:^|[\\/])data[\\/]ecommerce\.db/,
];

function walk(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else files.push(fullPath);
  }
  return files;
}

function relativeImports(source: string): string[] {
  const imports: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]!);
  return imports;
}

export interface ArtifactInspection {
  files: string[];
  violations: string[];
}

export function inspectProductionArtifact(distDir = defaultDistDir): ArtifactInspection {
  const files = walk(distDir);
  const violations: string[] = [];

  if (files.length === 0) violations.push("dist is empty");
  if (!fs.existsSync(path.join(distDir, "main.js"))) {
    violations.push("main.js is missing");
  }

  for (const file of files) {
    const relativePath = path.relative(distDir, file).replace(/\\/g, "/");
    for (const pattern of forbiddenPaths) {
      if (pattern.test(relativePath)) {
        violations.push(`${relativePath}: forbidden path ${pattern}`);
      }
    }

    if (!/\.(?:js|json)$/i.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of forbiddenContent) {
      if (pattern.test(source)) {
        violations.push(`${relativePath}: forbidden content ${pattern}`);
      }
    }

    if (!file.endsWith(".js")) continue;
    for (const specifier of relativeImports(source)) {
      const target = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(target)) {
        violations.push(`${relativePath}: dangling import ${specifier}`);
      }
    }
  }

  return { files, violations };
}

export function main(): void {
  const inspection = inspectProductionArtifact();
  if (inspection.violations.length > 0) {
    console.error("verify:artifact failed");
    for (const violation of inspection.violations) {
      console.error(`  - ${violation}`);
    }
    process.exitCode = 1;
    return;
  }
  console.info(`verify:artifact passed (${inspection.files.length} files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) main();
