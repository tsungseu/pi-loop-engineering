#!/usr/bin/env node
/**
 * Shell guard for Claude/Cursor plugin hooks.
 *
 * Reads JSON from stdin, extracts a shell command from known payload fields,
 * and denies high-risk patterns. Never grants authorization.
 *
 * Denied patterns (case-insensitive unless noted):
 * - releasectl action / mutate / reconcile / physical flags
 * - deploy-robot, run-hil, run-real-robot
 * - deploy to/on real robot or hardware targets
 * - rm -rf / (root filesystem destruction)
 * - firmware flash / esptool / dfu-util / avrdude / st-flash heuristics
 * - robot actuation / real-robot execution hints
 *
 * Exit codes:
 * - 0: allow (safe or unclassified)
 * - 1: deny (high-risk pattern matched)
 */

import { readFileSync } from "node:fs";

const HIGH_RISK_PATTERNS = [
  {
    name: "releasectl-mutate",
    regex: /\breleasectl\b(?:\s+\S+){0,8}\s+(?:action|mutate|reconcile)\b/i,
  },
  {
    name: "releasectl-physical-flag",
    regex: /\breleasectl\b[^\n\r]{0,160}\b--(?:physical|authorize(?:d)?|authorization)\b/i,
  },
  {
    name: "deploy-robot",
    regex: /\bdeploy[-_ ]?robot\b/i,
  },
  {
    name: "run-hil",
    regex: /\brun[-_ ]?hil\b/i,
  },
  {
    name: "run-real-robot",
    regex: /\brun[-_ ]?real[-_ ]?robot\b/i,
  },
  {
    name: "deploy-to-target",
    regex: /\bdeploy\b.{0,80}\b(?:to|on)\b.{0,80}\b(?:robot|hardware|device|真机)\b/i,
  },
  {
    name: "rm-rf-root",
    regex: /\brm\s+(?:-[a-zA-Z]*f[a-zA-Z]*\s+|-f\s+-r\s+|-rf\s+|-fr\s+)*\/(?:\s|$)/i,
  },
  {
    name: "firmware-flash",
    regex: /\b(?:flash(?:ing)?\s+firmware|firmware\s+flash|esptool(?:\.py)?\s+write_flash|dfu-util|avrdude|st-flash)\b/i,
  },
  {
    name: "robot-actuation",
    regex: /\b(?:robot\s+actuation|actuate\s+robot|real[-_ ]robot\s+(?:run|deploy|execute))\b/i,
  },
];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function extractCommand(payload) {
  if (typeof payload === "string") {
    return payload.trim();
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const candidates = [
    payload.command,
    payload.shellCommand,
    payload.tool_input?.command,
    payload.toolInput?.command,
    payload.input?.command,
    payload.arguments?.command,
    payload.args?.command,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function matchHighRisk(command) {
  if (!command) {
    return null;
  }
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.regex.test(command)) {
      return pattern.name;
    }
  }
  return null;
}

function deny(reason, command) {
  const message = [
    "PI Loop Engineering shell guard: denied high-risk command.",
    `Matched pattern: ${reason}.`,
    command ? `Command: ${command}` : "",
    "Hooks never grant physical or release authorization.",
    "Use triggerctl classify and JIT authorization via releasectl when appropriate.",
  ]
    .filter(Boolean)
    .join("\n");

  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const raw = readStdin().trim();
let payload = {};
if (raw) {
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { command: raw };
  }
}

const command = extractCommand(payload);
const matched = matchHighRisk(command);
if (matched) {
  deny(matched, command);
}

process.exit(0);
