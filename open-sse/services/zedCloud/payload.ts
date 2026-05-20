/**
 * Build Zed Cloud completions envelope from OpenAI or Anthropic chat bodies.
 * Ported from zed2api providers.zig.
 */

import { randomUUID } from "node:crypto";

type JsonRecord = Record<string, unknown>;

export type ZedVendor = "anthropic" | "open_ai" | "google" | "x_ai";

const ZED_CLAUDE_MODELS = [
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-3-7-sonnet",
  "claude-haiku-4-5",
] as const;

function normalizeZedPrefixedModel(name: string): string {
  return name.startsWith("zed-cloud/") ? name.slice("zed-cloud/".length) : name;
}

export function normalizeModelName(name: string): string {
  name = normalizeZedPrefixedModel(name);
  for (const model of ZED_CLAUDE_MODELS) {
    if (name === model || name.startsWith(`${model}-thinking`)) return model;
  }
  return name;
}

export function getZedVendor(model: string): ZedVendor {
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt-")) return "open_ai";
  if (model.startsWith("gemini")) return "google";
  if (model.startsWith("grok")) return "x_ai";
  return "anthropic";
}

export function extractModel(body: unknown): string {
  if (!body || typeof body !== "object") return "claude-sonnet-4-5";
  const model = (body as JsonRecord).model;
  if (typeof model === "string") return normalizeModelName(model);
  return "claude-sonnet-4-5";
}

function extractSystemText(parsed: JsonRecord): string | null {
  const sys = parsed.system;
  if (typeof sys === "string") return sys;
  if (Array.isArray(sys)) {
    const parts: string[] = [];
    for (const item of sys) {
      if (item && typeof item === "object" && typeof (item as JsonRecord).text === "string") {
        parts.push((item as JsonRecord).text as string);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  return null;
}

function openAiContentToAnthropic(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];

  const out: unknown[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as JsonRecord;
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: "text", text: part.text });
      continue;
    }
    out.push(part);
  }
  return out;
}

function openAiToolsToAnthropic(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  const out: unknown[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = (tool as JsonRecord).function;
    if (!fn || typeof fn !== "object") continue;
    const entry: JsonRecord = { name: (fn as JsonRecord).name ?? "" };
    if ((fn as JsonRecord).description) entry.description = (fn as JsonRecord).description;
    if ((fn as JsonRecord).parameters) entry.input_schema = (fn as JsonRecord).parameters;
    out.push(entry);
  }
  return out;
}

function buildAnthropicProviderRequest(
  parsed: JsonRecord,
  model: string,
  isAnthropic: boolean
): JsonRecord {
  const req: JsonRecord = {
    model,
    max_tokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : 8192,
  };
  const sys = extractSystemText(parsed);
  if (sys) req.system = sys;
  if (parsed.temperature !== undefined) req.temperature = parsed.temperature;
  if (parsed.thinking !== undefined) req.thinking = parsed.thinking;

  if (isAnthropic) {
    if (parsed.tools) req.tools = parsed.tools;
    if (parsed.tool_choice) req.tool_choice = parsed.tool_choice;
    req.messages = parsed.messages ?? [];
  } else {
    const tools = openAiToolsToAnthropic(parsed.tools);
    if (tools.length > 0) req.tools = tools;
    const tc = parsed.tool_choice;
    if (tc === "auto") req.tool_choice = { type: "auto" };
    else if (tc === "required") req.tool_choice = { type: "any" };
    else if (tc && typeof tc === "object") req.tool_choice = tc;
    req.messages = convertOpenAiMessagesToAnthropic(parsed.messages);
  }
  return req;
}

function convertOpenAiMessagesToAnthropic(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  const out: unknown[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as JsonRecord;
    const role = m.role;
    if (role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content ?? "",
          },
        ],
      });
      continue;
    }
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      const content: unknown[] = [];
      if (m.content) {
        content.push({ type: "text", text: typeof m.content === "string" ? m.content : "" });
      }
      for (const tc of m.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const t = tc as JsonRecord;
        const fn = t.function as JsonRecord | undefined;
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
          id: t.id,
          name: fn?.name,
          input,
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    if (role === "system") continue;
    out.push({
      role,
      content: openAiContentToAnthropic(m.content),
    });
  }
  return out;
}

function buildOpenAiProviderRequest(
  parsed: JsonRecord,
  model: string,
  isAnthropic: boolean
): JsonRecord {
  const input: unknown[] = [];
  if (isAnthropic) {
    const sys = extractSystemText(parsed);
    if (sys) {
      input.push({
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: sys }],
      });
    }
  }
  const messages = parsed.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg as JsonRecord;
      const role = m.role;
      if (typeof role !== "string") continue;
      const contentType = role === "assistant" ? "output_text" : "input_text";
      const parts: unknown[] = [];
      const content = m.content;
      if (typeof content === "string") {
        parts.push({ type: contentType, text: content });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item && typeof item === "object" && typeof (item as JsonRecord).text === "string") {
            parts.push({ type: contentType, text: (item as JsonRecord).text });
          }
        }
      }
      input.push({ type: "message", role, content: parts });
    }
  }
  return { model, stream: true, input };
}

function buildGoogleProviderRequest(
  parsed: JsonRecord,
  model: string,
  isAnthropic: boolean
): JsonRecord {
  const req: JsonRecord = {
    model: `models/${model}`,
    generationConfig: { candidateCount: 1, stopSequences: [], temperature: 1.0 },
    contents: [],
  };
  const sys = extractSystemText(parsed);
  if (sys) req.systemInstruction = { parts: [{ text: sys }] };

  const messages = parsed.messages;
  if (Array.isArray(messages)) {
    const contents: unknown[] = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg as JsonRecord;
      const role = m.role === "assistant" ? "model" : m.role;
      const parts: unknown[] = [];
      const content = m.content;
      if (typeof content === "string") parts.push({ text: content });
      else if (Array.isArray(content)) {
        for (const item of content) {
          if (item && typeof item === "object" && typeof (item as JsonRecord).text === "string") {
            parts.push({ text: (item as JsonRecord).text });
          }
        }
      }
      contents.push({ parts, role });
    }
    req.contents = contents;
  }
  return req;
}

function buildXaiProviderRequest(parsed: JsonRecord, model: string): JsonRecord {
  const req: JsonRecord = {
    model,
    stream: true,
    temperature: parsed.temperature ?? 1.0,
    messages: parsed.messages ?? [],
  };
  return req;
}

export function buildZedPayload(body: unknown, options: { isAnthropicTarget: boolean }): string {
  const parsed = (body && typeof body === "object" ? body : {}) as JsonRecord;
  const model = extractModel(parsed);
  const vendor = getZedVendor(model);

  let providerRequest: JsonRecord;
  if (vendor === "anthropic") {
    providerRequest = buildAnthropicProviderRequest(parsed, model, options.isAnthropicTarget);
  } else if (vendor === "open_ai") {
    providerRequest = buildOpenAiProviderRequest(parsed, model, options.isAnthropicTarget);
  } else if (vendor === "google") {
    providerRequest = buildGoogleProviderRequest(parsed, model, options.isAnthropicTarget);
  } else {
    providerRequest = buildXaiProviderRequest(parsed, model);
  }

  const envelope = {
    thread_id: randomUUID(),
    prompt_id: randomUUID(),
    intent: "user_prompt",
    provider: vendor,
    model,
    provider_request: providerRequest,
  };

  return JSON.stringify(envelope);
}
