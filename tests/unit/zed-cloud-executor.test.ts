import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { ZedCloudExecutor } from "@omniroute/open-sse/executors/zedCloud.ts";

function makeJwt(exp: number) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function withMockedFetch<TResult>(fetchImpl: typeof fetch, fn: () => Promise<TResult>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("zed-cloud executor", () => {
  it("does not leak stack traces in error bodies", () => {
    const body = buildErrorBody(502, "Error: fail\n    at /home/me/secret/file.ts:10:1");
    const msg = body.error.message;
    assert.ok(!msg.includes("at /"));
    assert.ok(!msg.includes("file.ts"));
    assert.equal(sanitizeErrorMessage("x\n    at /a/b.ts:1:1"), "x");
  });

  it("sends the fetched JWT authorization header to completions", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    await withMockedFetch(
      async (url, init = {}) => {
        const headers = new Headers(init.headers as HeadersInit);
        calls.push({ url: String(url), authorization: headers.get("authorization") });
        if (String(url) === "https://cloud.zed.dev/client/llm_tokens") {
          return new Response(
            JSON.stringify({ token: makeJwt(Math.floor(Date.now() / 1000) + 3600) }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (String(url) === "https://cloud.zed.dev/completions") {
          const payload = JSON.parse(String(init.body));
          assert.deepEqual(payload.provider_request.messages, [
            { role: "user", content: [{ type: "text", text: "hi" }] },
          ]);
          return new Response(
            '{"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n',
            { status: 200, headers: { "content-type": "application/x-ndjson" } }
          );
        }
        throw new Error(`Unexpected URL: ${String(url)}`);
      },
      async () => {
        const executor = new ZedCloudExecutor();
        const result = await executor.execute({
          model: "claude-haiku-4-5",
          body: {
            model: "claude-haiku-4-5",
            messages: [{ role: "user", content: "hi" }],
          },
          stream: false,
          credentials: {
            connectionId: "conn-1",
            providerSpecificData: {
              userId: "user-1",
              credentialJson: JSON.stringify({ version: 2, id: "client_token", token: "secret" }),
            },
          },
        });
        assert.equal(result.response.status, 200);
      }
    );

    assert.equal(calls[0].url, "https://cloud.zed.dev/client/llm_tokens");
    assert.match(calls[0].authorization || "", /^user-1 \{/);
    assert.equal(calls[1].url, "https://cloud.zed.dev/completions");
    assert.match(calls[1].authorization || "", /^Bearer /);
  });
});
