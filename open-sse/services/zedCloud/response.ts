/**
 * Aggregate Zed Cloud NDJSON completion lines into OpenAI or Anthropic responses.
 */

type JsonRecord = Record<string, unknown>;

type ExtractedContent = {
  text: string;
  thinking: string | null;
  toolCallsJson: string | null;
};

function parseNdjsonLines(response: string): JsonRecord[] {
  const lines: JsonRecord[] = [];
  for (const line of response.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try {
      lines.push(JSON.parse(trimmed) as JsonRecord);
    } catch {
      /* skip malformed */
    }
  }
  return lines;
}

function getEventObject(line: JsonRecord): JsonRecord {
  const event = line.event;
  if (event && typeof event === "object") return event as JsonRecord;
  return line;
}

export function extractContentFromStream(response: string): ExtractedContent {
  let text = "";
  let thinking: string | null = null;
  const toolCalls: unknown[] = [];
  let currentToolId: string | null = null;
  let currentToolName: string | null = null;
  let toolInputJson = "";

  for (const line of parseNdjsonLines(response)) {
    const obj = getEventObject(line);
    const eventType = obj.type;
    if (typeof eventType !== "string") {
      if (Array.isArray(obj.choices)) {
        const choice = obj.choices[0] as JsonRecord | undefined;
        const delta = choice?.delta as JsonRecord | undefined;
        const content = delta?.content;
        if (typeof content === "string") text += content;
      }
      if (Array.isArray(obj.candidates)) {
        const cand = obj.candidates[0] as JsonRecord | undefined;
        const parts = (cand?.content as JsonRecord | undefined)?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part && typeof part === "object" && typeof (part as JsonRecord).text === "string") {
              text += (part as JsonRecord).text as string;
            }
          }
        }
      }
      continue;
    }

    if (eventType === "content_block_start") {
      const cb = obj.content_block as JsonRecord | undefined;
      if (cb?.type === "tool_use") {
        currentToolId = typeof cb.id === "string" ? cb.id : null;
        currentToolName = typeof cb.name === "string" ? cb.name : null;
        toolInputJson = "";
      }
      continue;
    }

    if (eventType === "content_block_delta") {
      const delta = obj.delta as JsonRecord | undefined;
      const dt = delta?.type;
      if (dt === "text_delta" && typeof delta?.text === "string") text += delta.text;
      else if (dt === "thinking_delta" && typeof delta?.thinking === "string") {
        thinking = (thinking ?? "") + delta.thinking;
      } else if (dt === "input_json_delta" && typeof delta?.partial_json === "string") {
        toolInputJson += delta.partial_json;
      }
      continue;
    }

    if (eventType === "content_block_stop" && currentToolId && currentToolName) {
      let args = toolInputJson || "{}";
      try {
        JSON.parse(args);
      } catch {
        args = "{}";
      }
      toolCalls.push({
        id: currentToolId,
        type: "function",
        function: { name: currentToolName, arguments: args },
      });
      currentToolId = null;
      currentToolName = null;
      toolInputJson = "";
      continue;
    }

    if (eventType === "response.output_text.delta" && typeof obj.delta === "string") {
      text += obj.delta;
    }
  }

  return {
    text,
    thinking,
    toolCallsJson: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
  };
}

export function convertToOpenAI(response: string, model: string): string {
  const sc = extractContentFromStream(response);
  const finishReason = sc.toolCallsJson ? "tool_calls" : "stop";
  const message: JsonRecord = { role: "assistant" };
  if (sc.thinking) message.thinking = sc.thinking;
  if (sc.toolCallsJson && !sc.text) {
    message.content = null;
    message.tool_calls = JSON.parse(sc.toolCallsJson);
  } else {
    message.content = sc.text;
    if (sc.toolCallsJson) message.tool_calls = JSON.parse(sc.toolCallsJson);
  }
  return JSON.stringify({
    id: "chatcmpl-zed",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  });
}

export function convertToAnthropic(response: string, model: string): string {
  const sc = extractContentFromStream(response);
  const content: unknown[] = [];
  if (sc.thinking) content.push({ type: "thinking", thinking: sc.thinking });
  if (sc.text) content.push({ type: "text", text: sc.text });
  if (sc.toolCallsJson) {
    const tools = JSON.parse(sc.toolCallsJson) as JsonRecord[];
    for (const tc of tools) {
      const fn = tc.function as JsonRecord | undefined;
      let input: unknown = {};
      if (fn?.arguments && typeof fn.arguments === "string") {
        try {
          input = JSON.parse(fn.arguments);
        } catch {
          input = {};
        }
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: fn?.name,
        input,
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const stopReason = sc.toolCallsJson ? "tool_use" : "end_turn";
  return JSON.stringify({
    id: "msg_zed",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
  });
}
