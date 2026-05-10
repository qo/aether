import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const banned = [
  "simu" + "late",
  "Simulated" + "Data",
  "Mock" + "Csi",
  "Fake" + "Frame",
  "synthetic" + "_stream",
  "demo" + "_mode"
];

const ignoredDirs = new Set([
  ".git",
  ".next",
  "node_modules",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  "data",
  "docs/archive",
  "tests",
  "apps/api/tests",
  "apps/web/tests",
  "services/collector/tests",
  "services/dsp/tests",
  "services/kb/tests",
  "services/agent/tests"
]);

const ignoredFiles = new Set([
  "package-lock.json",
  // The PROBLEMS catalogue legitimately discusses what we banned.
  "PROBLEMS.md",
  "scripts/no_nonreal_data_check.mjs"
]);

const extensions = new Set([
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".py",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".toml",
  ".ps1",
  ".sh",
  ".css"
]);

const failures = [];

walk(root);

if (failures.length) {
  console.error("No-fake-data contract failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("No-fake-data contract passed.");

function walk(dir) {
  // readdirSync can throw EPERM on Windows for some cache dirs (.pytest_cache
  // sub-entries created by pytest). A scan failure should not be a build
  // failure; log and move on so this stays a soft contract check, not a
  // tripwire on someone's machine state.
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.warn(`no-fake-data: skipping unreadable dir ${dir}: ${err.code || err.message}`);
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = normalize(relative(root, full));
    let stat;
    try {
      stat = statSync(full);
    } catch (err) {
      console.warn(`no-fake-data: skipping unreadable entry ${rel}: ${err.code || err.message}`);
      continue;
    }
    if (stat.isDirectory()) {
      const parts = rel.split("/");
      if ([...ignoredDirs].some((ignored) => rel === ignored || rel.startsWith(`${ignored}/`) || parts.includes(ignored))) continue;
      walk(full);
      continue;
    }
    if (ignoredFiles.has(rel)) continue;
    if (!extensions.has(ext(entry))) continue;
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch (err) {
      console.warn(`no-fake-data: skipping unreadable file ${rel}: ${err.code || err.message}`);
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of banned) {
        if (line.includes(pattern)) {
          failures.push(`${rel}:${index + 1} contains ${pattern}`);
        }
      }
    });
  }
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}

function ext(file) {
  const index = file.lastIndexOf(".");
  return index >= 0 ? file.slice(index) : "";
}
