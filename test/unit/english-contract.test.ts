import assert from "node:assert/strict";
import test from "node:test";
import { assertPluginAuthoredEnglish } from "../../tooling/english-contract.js";

const opaqueEvidence = {
  argv: ["simulator", "--scenario", "\u6d4b\u8bd5\u573a\u666f"],
  cwd: "C:/\u9879\u76ee/\u5de5\u4f5c\u533a",
  tool_versions: { "\u4eff\u771f\u5668": "\u7248\u672c-1" },
  stdout_path: "evidence/\u6807\u51c6\u8f93\u51fa.bin",
  stderr_path: "evidence/\u6807\u51c6\u9519\u8bef.bin",
};

test("English contract exempts opaque Evidence strings in both fixture collection shapes", () => {
  assert.doesNotThrow(() => assertPluginAuthoredEnglish({ evidence: opaqueEvidence }));
  assert.doesNotThrow(() => assertPluginAuthoredEnglish({ evidence: [opaqueEvidence] }));
  assert.doesNotThrow(() => assertPluginAuthoredEnglish({ loop: { markdown_body: "\u4e2d\u6587 Markdown" } }));
});

test("English contract rejects plugin-authored narrative fields in both fixture collection shapes", () => {
  assert.throws(
    () => assertPluginAuthoredEnglish({ "agent-result": { summary: "\u5df2\u5b8c\u6210" } }),
    /agent-result.*summary/u,
  );
  assert.throws(
    () => assertPluginAuthoredEnglish({ harness: [{ kind: "H1", objective: "\u5b9e\u73b0\u63a7\u5236\u5668" }] }),
    /harness.*objective/u,
  );
  assert.throws(
    () => assertPluginAuthoredEnglish({ evidence: { ...opaqueEvidence, actor_role: "\u6267\u884c\u8005" } }),
    /evidence.*actor_role/u,
  );
});

test("English contract rejects plugin-authored machine identity fields across contracts", () => {
  assert.throws(
    () => assertPluginAuthoredEnglish({ event: { actor_role: "\u63a7\u5236\u5668", payload: { kind: "\u4e8b\u4ef6" } } }),
    /event.*actor_role/u,
  );
  assert.throws(
    () => assertPluginAuthoredEnglish({ event: { actor_role: "controller", payload: { kind: "\u4e8b\u4ef6" } } }),
    /event.*payload\.kind/u,
  );
  assert.throws(
    () => assertPluginAuthoredEnglish({ "agent-request": { actor_role: "\u5de5\u4f5c\u8005" } }),
    /agent-request.*actor_role/u,
  );
  assert.throws(
    () => assertPluginAuthoredEnglish({ harness: [{ kind: "H1", actors: [{ actor_role: "\u5de5\u4f5c\u8005", model_class: "\u7f16\u7801" }] }] }),
    /harness.*actors\[0\]\.(actor_role|model_class)/u,
  );
});
