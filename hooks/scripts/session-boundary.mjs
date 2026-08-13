#!/usr/bin/env node
/**
 * Session boundary reminder for Claude/Cursor plugin hooks.
 * Prints guardrail context to stderr; no side effects; never grants authority.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLASSIFY_CMD = `node ${resolve(PLUGIN_ROOT, "dist/cli/triggerctl.js")} classify`;

const BOUNDARY = [
  "PI Loop Engineering session boundary:",
  "- Public skills only: loop-engineering, status, release, knowledge-evolution.",
  `- Classify with \`${CLASSIFY_CMD}\` before any side effects.`,
  "- Hooks and skills alone do not grant physical action or release authority.",
  "- Use JIT authorization and releasectl for authorized physical or release actions.",
].join("\n");

process.stderr.write(`${BOUNDARY}\n`);
process.exit(0);
