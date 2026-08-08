import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testOutput = resolve(repositoryRoot, ".test-dist");
const [group, ...forwardedArguments] = process.argv.slice(2);

if (group === undefined || !/^[A-Za-z0-9_-]+$/.test(group)) {
  throw new Error("A test group containing only letters, numbers, underscores, or hyphens is required.");
}

function run(arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, arguments_, { cwd: repositoryRoot, stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Child process exited with ${signal === null ? `code ${code}` : `signal ${signal}`}.`));
    });
  });
}

async function listTests(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const tests = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...await listTests(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      tests.push(path);
    }
  }
  return tests.sort();
}

await rm(testOutput, { recursive: true, force: true });
await run([
  resolve(repositoryRoot, "tooling", "generate-validators.mjs"),
  resolve(testOutput, "src", "generated", "validators.js"),
]);
const compiler = resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
await run([compiler, "-p", "tsconfig.test.json"]);

const tests = await listTests(resolve(testOutput, "test", group));
if (tests.length === 0) {
  throw new Error(`No tests found for group ${group}.`);
}

await run(["--test", ...tests, ...forwardedArguments]);
