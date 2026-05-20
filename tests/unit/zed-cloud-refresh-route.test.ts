import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-zed-refresh-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const refreshRoute = await import("../../src/app/api/providers/[id]/refresh/route.ts");

function makeJwt(exp: number) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function withMockedFetch(fetchImpl: typeof fetch, fn: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("zed-cloud manual refresh validates credential JSON via llm_tokens without requiring refresh_token", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "zed-cloud",
    authType: "oauth",
    accessToken: JSON.stringify({ version: 2, id: "client_token_test", token: "secret" }),
    providerSpecificData: {
      userId: "user-123",
      credentialJson: JSON.stringify({ version: 2, id: "client_token_test", token: "secret" }),
      authMethod: "browser",
    },
    testStatus: "expired",
    lastError: "old error",
  });

  const calls: Array<{ url: string; authorization: string | null }> = [];
  await withMockedFetch(
    async (url, init = {}) => {
      const headers = new Headers(init.headers as HeadersInit);
      calls.push({ url: String(url), authorization: headers.get("authorization") });
      return new Response(
        JSON.stringify({ token: makeJwt(Math.floor(Date.now() / 1000) + 3600) }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    },
    async () => {
      const res = await refreshRoute.POST(
        new Request("http://localhost/api/providers/id/refresh"),
        {
          params: Promise.resolve({ id: connection.id }),
        }
      );
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.provider, "zed-cloud");
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cloud.zed.dev/client/llm_tokens");
  assert.match(calls[0].authorization || "", /^user-123 \{/);

  const updated = await providersDb.getProviderConnectionById(connection.id);
  assert.equal(updated?.name, "Zed Cloud (user-123)");
  assert.equal(updated?.testStatus, "active");
  assert.notEqual(updated?.lastError, "old error");
});

test("zed-cloud connection test validates llm token and models endpoint", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "zed-cloud",
    authType: "oauth",
    name: "Zed Cloud",
    accessToken: JSON.stringify({ version: 2, id: "client_token_test", token: "secret" }),
    providerSpecificData: {
      userId: "user-123",
      credentialJson: JSON.stringify({ version: 2, id: "client_token_test", token: "secret" }),
      authMethod: "browser",
    },
    testStatus: "expired",
  });

  const providerTestRoute = await import("../../src/app/api/providers/[id]/test/route.ts");
  const calls: string[] = [];
  await withMockedFetch(
    async (url, init = {}) => {
      calls.push(String(url));
      if (String(url) === "https://cloud.zed.dev/client/llm_tokens") {
        return new Response(
          JSON.stringify({ token: makeJwt(Math.floor(Date.now() / 1000) + 3600) }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      if (String(url) === "https://cloud.zed.dev/models") {
        const auth = new Headers(init.headers as HeadersInit).get("authorization") || "";
        assert.match(auth, /^Bearer /);
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    },
    async () => {
      const result = await providerTestRoute.testSingleConnection(connection.id);
      assert.equal(result.valid, true);
      assert.equal(result.error, null);
      assert.equal(result.diagnosis?.type, "ok");
    }
  );

  assert.deepEqual(calls, [
    "https://cloud.zed.dev/client/llm_tokens",
    "https://cloud.zed.dev/models",
  ]);
});
