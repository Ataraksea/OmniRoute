import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

describe("zed-cloud executor error sanitization", () => {
  it("does not leak stack traces in error bodies", () => {
    const body = buildErrorBody(502, "Error: fail\n    at /home/me/secret/file.ts:10:1");
    const msg = body.error.message;
    assert.ok(!msg.includes("at /"));
    assert.ok(!msg.includes("file.ts"));
    assert.equal(sanitizeErrorMessage("x\n    at /a/b.ts:1:1"), "x");
  });
});
