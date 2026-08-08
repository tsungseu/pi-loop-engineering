import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [outputArgument, ...extraArguments] = process.argv.slice(2);

if (outputArgument === undefined || extraArguments.length > 0 || isAbsolute(outputArgument)) {
  throw new Error("Usage: node tooling/build.mjs <repository-relative-output-root>");
}

const outputRoot = resolve(repositoryRoot, outputArgument);
const outputRelative = relative(repositoryRoot, outputRoot);

if (outputRelative === "" || outputRelative.startsWith("..") || isAbsolute(outputRelative)) {
  throw new Error("Build output must be inside the repository and cannot be its root.");
}

const compiler = resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

function run(command, arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { cwd: repositoryRoot, stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Compiler exited with ${signal === null ? `code ${code}` : `signal ${signal}`}.`));
    });
  });
}

async function listSourceMaps(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const maps = [];

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      maps.push(...await listSourceMaps(path));
    } else if (entry.isFile() && entry.name.endsWith(".map")) {
      maps.push(path);
    }
  }

  return maps.sort();
}

await rm(outputRoot, { recursive: true, force: true });
await run(process.execPath, [
  resolve(repositoryRoot, "tooling", "generate-validators.mjs"),
  resolve(outputRoot, "generated", "validators.js"),
]);
await run(process.execPath, [compiler, "-p", "tsconfig.json", "--outDir", outputRoot]);

for (const sourceMapPath of await listSourceMaps(outputRoot)) {
  const sourceMap = JSON.parse(await readFile(sourceMapPath, "utf8"));
  sourceMap.sourceRoot = "";
  await writeFile(sourceMapPath, JSON.stringify(sourceMap), "utf8");
}
