const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const roots = [root, path.join(root, "viewer")];
const ignoredDirs = new Set([
  ".git",
  ".python_deps",
  "__pycache__",
  "node_modules",
]);

function listJsFiles(dir) {
  const rows = [];
  if (!fs.existsSync(dir)) return rows;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name) || entry.name.startsWith("out")) continue;
      rows.push(...listJsFiles(path.join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      rows.push(path.join(dir, entry.name));
    }
  }
  return rows;
}

const files = [...new Set(roots.flatMap(listJsFiles))].sort();
let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`\n[syntax failed] ${path.relative(root, file)}\n`);
    process.stderr.write(result.stderr || result.stdout || "");
  }
}

if (failed) {
  process.stderr.write(`\n${failed}/${files.length} JavaScript files failed syntax check.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${files.length} JavaScript files.\n`);
}
