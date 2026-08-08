import assert from "node:assert/strict";
import test from "node:test";
import { LoopError, sha256Hex } from "../../src/contracts/domain.js";

test("LoopError carries a stable English code and details", () => {
  const error = new LoopError("INVALID_LOOP_ID", "Loop ID is invalid.", { value: "../bad" });
  assert.equal(error.code, "INVALID_LOOP_ID");
  assert.deepEqual(error.details, { value: "../bad" });
});

test("sha256Hex returns a branded lowercase digest", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
