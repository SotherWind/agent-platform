#!/usr/bin/env node
/**
 * tsc (moduleResolution=bundler) 不会给相对导入补 .js；
 * Node ESM 运行 dist/ 时需要扩展名。本脚本在 build 后就地重写。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

const IMPORT_RE =
  /((?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?|import\s*\(\s*|export\s+\*\s+from\s+)(['"])(\.[^'"]+?)(['"])/g;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, files);
    else if (ent.name.endsWith(".js")) files.push(full);
  }
  return files;
}

function resolveSpecifier(fromFile, spec) {
  if (/\.(js|json|node|mjs|cjs)$/.test(spec)) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(`${base}.js`)) return `${spec}.js`;
  if (fs.existsSync(path.join(base, "index.js"))) return `${spec}/index.js`;
  return null;
}

function rewriteFile(file) {
  const src = fs.readFileSync(file, "utf8");
  let changed = 0;
  const next = src.replace(IMPORT_RE, (match, prefix, q1, spec, q2) => {
    const fixed = resolveSpecifier(file, spec);
    if (!fixed) return match;
    changed += 1;
    return `${prefix}${q1}${fixed}${q2}`;
  });
  if (changed > 0) fs.writeFileSync(file, next);
  return changed;
}

const files = walk(distDir);
let total = 0;
for (const f of files) total += rewriteFile(f);
console.log(
  `fix-dist-esm-extensions: ${total} import(s) in ${files.length} file(s) under ${distDir}`,
);
