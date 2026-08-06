import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [outputArgument, ...extraArguments] = process.argv.slice(2);

if (outputArgument === undefined || extraArguments.length > 0) {
  throw new Error("Usage: node tooling/generate-validators.mjs <output-file>");
}

const outputPath = isAbsolute(outputArgument) ? outputArgument : resolve(repositoryRoot, outputArgument);
const schemaDirectory = resolve(repositoryRoot, "schemas");
const schemaFiles = (await readdir(schemaDirectory))
  .filter((name) => name.endsWith(".schema.json"))
  .sort();

function camelCaseSchemaName(name) {
  return name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

const records = [];
for (const file of schemaFiles) {
  const name = parse(file).name.replace(/\.schema$/, "");
  const schema = JSON.parse(await readFile(resolve(schemaDirectory, file), "utf8"));
  records.push({ file, id: schema.$id, name, schema });
}

const ajv = new Ajv2020({ allErrors: true, strict: true, code: { esm: true, source: true } });
for (const record of records) {
  ajv.addSchema(record.schema, record.id);
}
for (const record of records) {
  if (ajv.getSchema(record.id) === undefined) {
    throw new Error(`Schema ${record.file} did not compile.`);
  }
}

const namedExports = Object.fromEntries(
  records.map((record) => [camelCaseSchemaName(record.name), record.id]),
);
const standalone = standaloneCode(ajv, namedExports);
const generated = standalone
  .replace(
    /const (\w+) = require\("ajv\/dist\/runtime\/equal"\)\.default;/gu,
    (_match, name) => `const ${name} = function equal(left, right) {\n  if (left === right) return true;\n  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;\n  if (Array.isArray(left) !== Array.isArray(right)) return false;\n  const leftKeys = Object.keys(left);\n  const rightKeys = Object.keys(right);\n  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]));\n};`,
  )
  .replace(
    /const (\w+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/gu,
    (_match, name) => `const ${name} = function ucs2length(value) {\n  let length = 0;\n  for (let index = 0; index < value.length; index += 1) {\n    length += 1;\n    const code = value.charCodeAt(index);\n    if (code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length) {\n      const next = value.charCodeAt(index + 1);\n      if (next >= 0xDC00 && next <= 0xDFFF) index += 1;\n    }\n  }\n  return length;\n};`,
  );
if (/\brequire\s*\(|\bfrom\s+["']ajv|\bimport\s*\(["']ajv/iu.test(generated)) {
  throw new Error("Standalone validators contain an unresolved Ajv runtime dependency.");
}
const defaultEntries = records
  .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  .map((record) => `  ${JSON.stringify(record.name)}: ${camelCaseSchemaName(record.name)},`)
  .join("\n");
const moduleSource = `${generated.trimEnd()}\n\nconst validators = Object.freeze({\n${defaultEntries}\n});\nexport default validators;\n`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, moduleSource, "utf8");
