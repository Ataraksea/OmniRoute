/**
 * ZedCloudExecutor — routes chat through Zed Cloud (cloud.zed.dev).
 * Ported from zed2api (Zig).
 */

import { BaseExecutor, mergeUpstreamExtraHeaders, type ExecuteInput } from "./base.ts";
import { FORMATS } from "../translator/formats.ts";
import { buildErrorBody } from "../utils/error.ts";
import { ZED_CLOUD_URLS, getZedClientVersion } from "../services/zedCloud/constants.ts";
import { buildZedPayload, extractModel } from "../services/zedCloud/payload.ts";
import { convertToAnthropic, convertToOpenAI } from "../services/zedCloud/response.ts";
import {
  convertZedStreamLine,
  createStreamTranslatorState,
  finishZedStream,
} from "../services/zedCloud/streamTranslator.ts";
import { clearZedJwtCache, fetchZedJwt } from "../services/zedCloud/token.ts";

export class ZedCloudExecutor extends BaseExecutor {
  constructor() {
    super("zed-cloud", {
      id: "zed-cloud",
      baseUrl: ZED_CLOUD_URLS.completions,
    });
  }

  buildUrl(): string {
    return ZED_CLOUD_URLS.completions;
  }

  buildHeaders(credentials: { accessToken?: string }, _stream?: boolean): Record<string, string> {
    const jwt = credentials.accessToken;
    return {
      Authorization: jwt ? `Bearer ${jwt}` : "",
      "Content-Type": "application/json",
      "x-zed-version": getZedClientVersion(),
    };
  }

  transformRequest(body: unknown): unknown {
    return body;
  }

  async execute(input: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    const { model, body, stream, credentials, signal, log, upstreamExtraHeaders } = input;
    const requestBody = body as Record<string, unknown> | null;
    const hasClaudeSystem = typeof requestBody?.system !== "undefined";
    const isAnthropicTarget =
      this.config.format === FORMATS.CLAUDE && Array.isArray(requestBody?.messages);

    const isAnthropicBody =
      isAnthropicTarget || (hasClaudeSystem && !Array.isArray(requestBody?.choices));

    const runOnce = async (retryOnAuth: boolean) => {
      const jwt = await fetchZedJwt(credentials, signal);
      const headers = this.buildHeaders({ accessToken: jwt });
      mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);
      const payload = buildZedPayload(body, {
        isAnthropicTarget: Boolean(
          (body as Record<string, unknown>)?.system !== undefined || isAnthropicBody
        ),
      });

      const response = await fetch(this.buildUrl(), {
        method: "POST",
        headers,
        body: payload,
        signal: signal ?? undefined,
      });

      if ((response.status === 401 || response.status === 403) && retryOnAuth) {
        clearZedJwtCache(credentials.connectionId);
        return runOnce(false);
      }

      return { response, headers, payload, jwt };
    };

    try {
      const { response, headers, payload } = await runOnce(true);

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        log?.error?.("ZED_CLOUD", `Upstream error ${response.status}`, {
          body: errText.slice(0, 300),
        });
        const errorBody = buildErrorBody(
          response.status,
          `Zed Cloud upstream error (${response.status})`
        );
        return {
          response: new Response(JSON.stringify(errorBody), {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          }),
          url: this.buildUrl(),
          headers,
          transformedBody: payload,
        };
      }

      const normalizedModel = extractModel(body);

      if (stream && response.body) {
        const clientIsAnthropic = isAnthropicBody;
        const sseStream = this.pipeNdjsonStream(response.body, {
          isAnthropic: clientIsAnthropic,
          model: normalizedModel,
          signal,
        });
        return {
          response: new Response(sseStream, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }),
          url: this.buildUrl(),
          headers,
          transformedBody: payload,
        };
      }

      const raw = await response.text();
      const converted = clientIsAnthropicResponse(body)
        ? convertToAnthropic(raw, normalizedModel)
        : convertToOpenAI(raw, normalizedModel);

      return {
        response: new Response(converted, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: this.buildUrl(),
        headers,
        transformedBody: payload,
      };
    } catch (err) {
      log?.error?.("ZED_CLOUD", "Execute failed", { err: String(err) });
      const errorBody = buildErrorBody(
        502,
        err instanceof Error ? err.message : "Zed Cloud request failed"
      );
      return {
        response: new Response(JSON.stringify(errorBody), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
        url: this.buildUrl(),
        headers: {},
        transformedBody: body,
      };
    }
  }

  private pipeNdjsonStream(
    body: ReadableStream<Uint8Array>,
    options: { isAnthropic: boolean; model: string; signal?: AbortSignal | null }
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const state = createStreamTranslatorState(options.model);
    let buffer = "";

    return new ReadableStream({
      async start(controller) {
        if (options.isAnthropic) {
          const messageId = `msg_zed_${Date.now()}`;
          controller.enqueue(
            encoder.encode(
              `event: message_start\ndata: ${JSON.stringify({
                type: "message_start",
                message: {
                  id: messageId,
                  type: "message",
                  role: "assistant",
                  model: options.model,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                },
              })}\n\n`
            )
          );
        }

        const reader = body.getReader();
        let lineBuf = "";

        try {
          while (true) {
            if (options.signal?.aborted) break;
            const { value, done } = await reader.read();
            if (done) break;
            lineBuf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = lineBuf.indexOf("\n")) >= 0) {
              const line = lineBuf.slice(0, nl);
              lineBuf = lineBuf.slice(nl + 1);
              const chunk = convertZedStreamLine(line, state, {
                isAnthropic: options.isAnthropic,
                model: options.model,
              });
              if (chunk) controller.enqueue(encoder.encode(chunk));
            }
          }
          lineBuf += decoder.decode();
          if (lineBuf.trim()) {
            const chunk = convertZedStreamLine(lineBuf, state, {
              isAnthropic: options.isAnthropic,
              model: options.model,
            });
            if (chunk) controller.enqueue(encoder.encode(chunk));
          }
          const fin = finishZedStream(state, {
            isAnthropic: options.isAnthropic,
            model: options.model,
          });
          if (fin) controller.enqueue(encoder.encode(fin));
          controller.close();
        } catch (e) {
          controller.error(e);
        } finally {
          reader.releaseLock();
        }
      },
    });
  }
}

function clientIsAnthropicResponse(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return b.system !== undefined && b.messages !== undefined && !b.stream_options;
}
