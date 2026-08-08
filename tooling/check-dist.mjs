import { randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedRoot = resolve(repositoryRoot, "dist");
const temporaryRelative = `.dist-check-${randomBytes(12).toString("hex")}`;
const temporaryRoot = resolve(repositoryRoot, temporaryRelative);

function run(arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, arguments_, { cwd: repositoryRoot, stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`Build exited with ${signal === null ? `code ${code}` : `signal ${signal}`}.`));
    });
  });
}

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }
  return files.sort();
}

try {
  await run([resolve(repositoryRoot, "tooling", "build.mjs"), temporaryRelative]);
  const expectedFiles = await listFiles(expectedRoot);
  const actualFiles = await listFiles(temporaryRoot);

  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Distribution file list differs. Expected ${JSON.stringify(expectedFiles)}, received ${JSON.stringify(actualFiles)}.`);
  }

  for (const file of expectedFiles) {
    const [expected, actual] = await Promise.all([
      readFile(resolve(expectedRoot, file)),
      readFile(resolve(temporaryRoot, file)),
    ]);
    if (!expected.equals(actual)) {
      throw new Error(`Distribution bytes differ for ${file}.`);
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
