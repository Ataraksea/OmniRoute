import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  convertZedStreamLine,
  createStreamTranslatorState,
  finishZedStream,
} from "@omniroute/open-sse/services/zedCloud/streamTranslator.ts";

describe("zed-cloud stream translator", () => {
  it("converts text_delta to OpenAI SSE chunk", () => {
    const state = createStreamTranslatorState("claude-sonnet-4-5");
    const line = JSON.stringify({
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
    });
    const out = convertZedStreamLine(line, state, {
      isAnthropic: false,
      model: "claude-sonnet-4-5",
    });
    assert.ok(out.includes("chat.completion.chunk"));
    assert.ok(out.includes("Hello"));
  });

  it("emits OpenAI DONE on finish", () => {
    const state = createStreamTranslatorState("gpt-5");
    state.headersSent = true;
    const fin = finishZedStream(state, { isAnthropic: false, model: "gpt-5" });
    assert.ok(fin.includes("[DONE]"));
  });
});
