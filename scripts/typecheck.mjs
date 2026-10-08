// Type-check a subset of the project with the repo's tsconfig options.
// Usage: node scripts/typecheck.mjs <file-or-dir> [more...]
// Reports only diagnostics located inside the given paths, so several people
// can work on separate modules while the rest of the tree is mid-refactor.
// With no arguments it checks everything under src/ and tests/.
import ts from "typescript";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = (process.argv.slice(2).length ? process.argv.slice(2) : ["src", "tests"]).map((p) => resolve(root, p));

const files = [];
const walk = (path) => {
  if (!existsSync(path)) { console.error(`missing: ${path}`); process.exitCode = 2; return; }
  if (statSync(path).isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
  if (/\.(ts|tsx)$/.test(path) && !path.endsWith(".d.ts")) files.push(path);
};
targets.forEach(walk);

const configPath = join(root, "tsconfig.json");
const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config, ts.sys, root);
const ambient = join(root, "src", "env.d.ts");
if (existsSync(ambient)) files.push(ambient);
const program = ts.createProgram(files, { ...options, noEmit: true, incremental: false, composite: false, types: ["vite/client", "node"] });
const inScope = (name) => targets.some((t) => resolve(name) === t || resolve(name).startsWith(t + sep));
const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => !d.file || inScope(d.file.fileName));

for (const d of diagnostics) {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (d.file && d.start !== undefined) {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    console.log(`${d.file.fileName.replace(root + sep, "")}:${line + 1}:${character + 1} TS${d.code} ${message}`);
  } else console.log(`TS${d.code} ${message}`);
}
console.log(`${files.length} file(s) checked, ${diagnostics.length} error(s) in scope`);
if (diagnostics.length) process.exitCode = 1;
