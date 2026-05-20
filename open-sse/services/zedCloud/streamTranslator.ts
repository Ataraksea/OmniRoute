/**
 * Convert Zed Cloud NDJSON stream lines to OpenAI or Anthropic SSE.
 */

import { randomUUID } from "node:crypto";

type JsonRecord = Record<string, unknown>;

export type StreamTranslatorState = {
  blockIndex: number;
  hasToolUse: boolean;
  headersSent: boolean;
  chatId: string;
};

export function createStreamTranslatorState(model: string): StreamTranslatorState {
  return {
    blockIndex: 0,
    hasToolUse: false,
    headersSent: false,
    chatId: `chatcmpl-zed-${randomUUID().slice(0, 8)}`,
  };
}

function getEventObject(parsed: JsonRecord): JsonRecord {
  const event = parsed.event;
  if (event && typeof event === "object") return event as JsonRecord;
  return parsed;
}

function emitOpenAiTextDelta(chatId: string, model: string, text: string): string {
  return `data: ${JSON.stringify({
    id: chatId,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`;
}

function emitAnthropicTextDelta(text: string, blockIndex: number, isFirst: boolean): string {
  let out = "";
  if (isFirst) {
    out +=
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
  }
  out += `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  })}\n\n`;
  return out;
}

/**
 * Convert one NDJSON line from Zed upstream to zero or more SSE chunks.
 */
export function convertZedStreamLine(
  line: string,
  state: StreamTranslatorState,
  options: { isAnthropic: boolean; model: string }
): string {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return "";

  let parsed: JsonRecord;
  try {
    parsed = JSON.parse(trimmed) as JsonRecord;
  } catch {
    return "";
  }

  const obj = getEventObject(parsed);
  const eventType = obj.type;
  if (typeof eventType !== "string") {
    if (Array.isArray(obj.choices)) {
      const choice = obj.choices[0] as JsonRecord | undefined;
      const delta = choice?.delta as JsonRecord | undefined;
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        state.headersSent = true;
        return options.isAnthropic
          ? emitAnthropicTextDelta(content, state.blockIndex, state.blockIndex === 0)
          : emitOpenAiTextDelta(state.chatId, options.model, content);
      }
    }
    if (Array.isArray(obj.candidates)) {
      const cand = obj.candidates[0] as JsonRecord | undefined;
      const parts = (cand?.content as JsonRecord | undefined)?.parts;
      if (Array.isArray(parts)) {
        let text = "";
        for (const part of parts) {
          if (part && typeof part === "object" && typeof (part as JsonRecord).text === "string") {
            text += (part as JsonRecord).text as string;
          }
        }
        if (text) {
          state.headersSent = true;
          return options.isAnthropic
            ? emitAnthropicTextDelta(text, state.blockIndex, state.blockIndex === 0)
            : emitOpenAiTextDelta(state.chatId, options.model, text);
        }
      }
    }
    return "";
  }

  if (eventType === "message_start") return "";

  if (eventType === "content_block_start") {
    if (!options.isAnthropic) return "";
    const cb = obj.content_block as JsonRecord | undefined;
    if (!cb) return "";
    const cbType = cb.type;
    if (cbType === "tool_use") {
      state.hasToolUse = true;
      return `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: state.blockIndex,
        content_block: {
          type: "tool_use",
          id: cb.id,
          name: cb.name,
          input: {},
        },
      })}\n\n`;
    }
    return `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: state.blockIndex,
      content_block: { type: cbType, text: cbType === "thinking" ? "" : "" },
    })}\n\n`;
  }

  if (eventType === "content_block_delta") {
    const delta = obj.delta as JsonRecord | undefined;
    if (!delta) return "";
    const dt = delta.type;
    if (!options.isAnthropic && dt === "text_delta" && typeof delta.text === "string") {
      state.headersSent = true;
      return emitOpenAiTextDelta(state.chatId, options.model, delta.text);
    }
    if (options.isAnthropic) {
      state.headersSent = true;
      return `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: state.blockIndex,
        delta,
      })}\n\n`;
    }
    return "";
  }

  if (eventType === "content_block_stop") {
    if (!options.isAnthropic) {
      state.blockIndex += 1;
      return "";
    }
    const out = `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: state.blockIndex,
    })}\n\n`;
    state.blockIndex += 1;
    state.headersSent = true;
    return out;
  }

  if (eventType === "ping" && options.isAnthropic) {
    return 'event: ping\ndata: {"type":"ping"}\n\n';
  }

  if (eventType === "response.output_text.delta" && typeof obj.delta === "string" && obj.delta) {
    state.headersSent = true;
    return options.isAnthropic
      ? emitAnthropicTextDelta(obj.delta, state.blockIndex, state.blockIndex === 0)
      : emitOpenAiTextDelta(state.chatId, options.model, obj.delta);
  }

  return "";
}

export function finishZedStream(
  state: StreamTranslatorState,
  options: { isAnthropic: boolean; model: string }
): string {
  if (!state.headersSent) return "";
  if (options.isAnthropic) {
    const stopReason = state.hasToolUse ? "tool_use" : "end_turn";
    return (
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: { output_tokens: 1 },
      })}\n\n` + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    );
  }
  return (
    `data: ${JSON.stringify({
      id: state.chatId,
      object: "chat.completion.chunk",
      model: options.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n` + "data: [DONE]\n\n"
  );
}
