import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const skillsRoot = join(repositoryRoot, "skills");

const OLD_COMMANDS = ["init", "run", "review", "learn", "superworkflows"] as const;
const LEGACY_TOKENS = [/\$init\b/u, /\$run\b/u, /\$review\b/u, /\$learn\b/u, /skills\/superworkflows/u, /codegraph\s+init/u];

async function skillNames(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function containsOldCommandOrAlias(root: string): Promise<boolean> {
  const names = await skillNames(root);
  if (OLD_COMMANDS.some((name) => names.includes(name))) return true;
  for (const name of names) {
    const skillMarkdown = await readFile(join(root, name, "SKILL.md"), "utf8");
    const yamlPath = join(root, name, "agents", "openai.yaml");
    let yaml = "";
    try {
      yaml = await readFile(yamlPath, "utf8");
    } catch {
      yaml = "";
    }
    const combined = `${skillMarkdown}\n${yaml}`;
    if (LEGACY_TOKENS.some((pattern) => pattern.test(combined))) return true;
  }
  return false;
}

async function assertFile(path: string): Promise<void> {
  await access(path);
}

test("skills expose exactly four commands and no Router Skill", async () => {
  assert.deepEqual(await skillNames(skillsRoot), [
    "knowledge-evolution",
    "loop-engineering",
    "release",
    "status",
  ]);
  assert.equal(await containsOldCommandOrAlias(skillsRoot), false);
});

test("each public Skill classifies through triggerctl before side effects", async () => {
  for (const name of ["knowledge-evolution", "loop-engineering", "release", "status"]) {
    const markdown = await readFile(join(skillsRoot, name, "SKILL.md"), "utf8");
    assert.match(markdown, /node\s+(?:<plugin-root>\/)?dist\/cli\/triggerctl\.js/u);
    assert.match(markdown, /before side effects|before any side effects|before mutating|before mutation/iu);
    await assertFile(join(skillsRoot, name, "agents", "openai.yaml"));
  }
});

test("loop-engineering documents persistent exact and session-only implicit contracts", async () => {
  const markdown = await readFile(join(skillsRoot, "loop-engineering", "SKILL.md"), "utf8");
  assert.match(markdown, /\$loop-engineering/u);
  assert.match(markdown, /session-only/iu);
  assert.match(markdown, /\bH0\b/u);
  assert.match(markdown, /\bH1\b/u);
  assert.match(markdown, /Sub-agents|sub-agents/u);
  assert.match(markdown, /Final Handoff/u);
  assert.match(markdown, /no Release authority|without Release authority|does not authorize Release/iu);
  assert.match(markdown, /assets\/loop-engineering\/review\.md/u);
  assert.match(markdown, /--mcp-available\s+true\b/u);
  assert.match(markdown, /codegraphctl\.js resolve/u);
});

test("status release and knowledge-evolution preserve authorization boundaries", async () => {
  const status = await readFile(join(skillsRoot, "status", "SKILL.md"), "utf8");
  assert.match(status, /read-only/iu);
  assert.match(status, /Do not create|must not create|never create/iu);
  assert.match(status, /loopctl/u);

  const release = await readFile(join(skillsRoot, "release", "SKILL.md"), "utf8");
  assert.match(release, /readiness-only|Readiness Check/iu);
  assert.match(release, /explicit action|action and target|action\/target/iu);
  assert.match(release, /readiness_or_authorized/u);
  assert.match(release, /node\s+(?:<plugin-root>\/)?dist\/cli\/releasectl\.js/u);

  const knowledge = await readFile(join(skillsRoot, "knowledge-evolution", "SKILL.md"), "utf8");
  assert.match(knowledge, /proposal/iu);
  assert.match(knowledge, /knowledgectl/u);
  assert.match(knowledge, /does not apply|must not apply|never apply/iu);
});

test("shared trigger policy lives outside skills and old policy is gone", async () => {
  await assertFile(join(repositoryRoot, "assets", "router", "trigger-policy.json"));
  await assert.rejects(
    () => access(join(repositoryRoot, "assets", "loop-engineering", "trigger-policy.json")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  const policy = JSON.parse(
    await readFile(join(repositoryRoot, "assets", "router", "trigger-policy.json"), "utf8"),
  ) as {
    exact: Record<string, string>;
    implicit: Record<string, string>;
  };
  assert.deepEqual(policy.exact, {
    "$loop-engineering": "PERSISTENT_LOOP",
    "$status": "READ_ONLY_STATUS",
    "$release": "READINESS_OR_AUTHORIZED_RELEASE",
    "$knowledge-evolution": "PROPOSAL_ONLY_EVOLUTION",
  });
  assert.deepEqual(policy.implicit, {
    complex_implementation: "SESSION_ONLY_LOOP",
    status: "READ_ONLY_STATUS",
    release: "READINESS_ONLY",
    knowledge: "RESPONSE_ONLY",
    review: "SESSION_ONLY_READ_ONLY_REVIEW",
  });
});
