import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildZedPayload,
  extractModel,
  getZedVendor,
  normalizeModelName,
} from "@omniroute/open-sse/services/zedCloud/payload.ts";

describe("zed-cloud payload", () => {
  it("normalizes Claude Code model aliases", () => {
    assert.equal(normalizeModelName("claude-sonnet-4-6"), "claude-sonnet-4-6");
    assert.equal(normalizeModelName("claude-sonnet-4-5-thinking"), "claude-sonnet-4-5");
  });

  it("maps model prefix to Zed vendor", () => {
    assert.equal(getZedVendor("claude-sonnet-4-5"), "anthropic");
    assert.equal(getZedVendor("gpt-5.2"), "open_ai");
    assert.equal(getZedVendor("gemini-2.5-pro"), "google");
    assert.equal(getZedVendor("grok-4"), "x_ai");
  });

  it("builds Zed envelope for OpenAI chat body", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    };
    const raw = buildZedPayload(body, { isAnthropicTarget: false });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.intent, "user_prompt");
    assert.equal(parsed.provider, "anthropic");
    assert.equal(parsed.model, "claude-sonnet-4-5");
    assert.ok(parsed.thread_id);
    assert.ok(parsed.provider_request);
    assert.equal(parsed.provider_request.model, "claude-sonnet-4-5");
    assert.equal(extractModel(body), "claude-sonnet-4-5");
  });

  it("strips OmniRoute provider prefix before sending model ids to Zed", () => {
    const body = {
      model: "zed-cloud/claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    };
    const parsed = JSON.parse(buildZedPayload(body, { isAnthropicTarget: false }));
    assert.equal(parsed.provider, "anthropic");
    assert.equal(parsed.model, "claude-sonnet-4-5");
    assert.equal(parsed.provider_request.model, "claude-sonnet-4-5");
    assert.equal(extractModel(body), "claude-sonnet-4-5");
  });

  it("converts OpenAI string content to Anthropic content blocks", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    };
    const parsed = JSON.parse(buildZedPayload(body, { isAnthropicTarget: false }));
    assert.deepEqual(parsed.provider_request.messages, [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("uses open_ai provider_request shape for gpt models", () => {
    const body = {
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
    };
    const parsed = JSON.parse(buildZedPayload(body, { isAnthropicTarget: false }));
    assert.equal(parsed.provider, "open_ai");
    assert.equal(parsed.provider_request.stream, true);
    assert.ok(Array.isArray(parsed.provider_request.input));
  });
});
