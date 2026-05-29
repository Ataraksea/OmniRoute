import test from "node:test";
import assert from "node:assert/strict";

import { AzureOpenAIExecutor } from "../../open-sse/executors/azure-openai.ts";

test("AzureOpenAIExecutor builds deployment-based chat URLs from the resource endpoint", () => {
  const executor = new AzureOpenAIExecutor();
  const url = executor.buildUrl("my-gpt4o-deployment", true, 0, {
    providerSpecificData: {
      baseUrl: "https://my-resource.openai.azure.com",
    },
  });

  assert.equal(
    url,
    "https://my-resource.openai.azure.com/openai/deployments/my-gpt4o-deployment/chat/completions?api-version=2024-12-01-preview"
  );
});

test("AzureOpenAIExecutor strips duplicated /openai suffixes from configured base URLs", () => {
  const executor = new AzureOpenAIExecutor();
  const url = executor.buildUrl("deploy-1", false, 0, {
    providerSpecificData: {
      baseUrl: "https://my-resource.openai.azure.com/openai/",
      apiVersion: "2025-01-01-preview",
    },
  });

  assert.equal(
    url,
    "https://my-resource.openai.azure.com/openai/deployments/deploy-1/chat/completions?api-version=2025-01-01-preview"
  );
});

test("AzureOpenAIExecutor uses api-key auth headers instead of Bearer auth", () => {
  const executor = new AzureOpenAIExecutor();
  const headers = executor.buildHeaders({ apiKey: "azure-key-123" }, true);

  assert.deepEqual(headers, {
    "Content-Type": "application/json",
    "api-key": "azure-key-123",
    Accept: "text/event-stream",
  });
});

test("AzureOpenAIExecutor maps max_tokens for GPT-5 chat deployments", () => {
  const executor = new AzureOpenAIExecutor();
  const deploymentBody = executor.transformRequest(
    "azure-gpt-55-deployment",
    {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 2048,
    },
    true,
    { providerSpecificData: {} }
  );

  assert.equal((deploymentBody as Record<string, unknown>).max_tokens, undefined);
  assert.equal((deploymentBody as Record<string, unknown>).max_completion_tokens, 2048);

  const prefixedBody = executor.transformRequest(
    "azure-openai/gpt-5.5",
    {
      model: "azure-openai/gpt-5.5",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
    },
    true,
    { providerSpecificData: {} }
  );

  assert.equal((prefixedBody as Record<string, unknown>).max_tokens, undefined);
  assert.equal((prefixedBody as Record<string, unknown>).max_completion_tokens, 1024);
});
