/**
 * Zed Cloud JWT token service — fetch and cache short-lived Bearer tokens.
 */

import type { ProviderCredentials } from "../../executors/base.ts";
import { ZED_CLOUD_URLS, ZED_JWT_REFRESH_BUFFER_SEC, ZED_SYSTEM_ID } from "./constants.ts";

type JwtCacheEntry = {
  token: string;
  expSec: number;
};

const jwtCacheByConnection = new Map<string, JwtCacheEntry>();

function parseJwtExpSec(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

export function getZedCredentialAuth(credentials: ProviderCredentials): {
  userId: string;
  credentialJson: string;
} | null {
  const psd = credentials.providerSpecificData;
  const userId =
    (typeof psd?.userId === "string" && psd.userId) ||
    (typeof psd?.user_id === "string" && psd.user_id) ||
    "";
  const credentialJson =
    (typeof psd?.credentialJson === "string" && psd.credentialJson) ||
    (typeof psd?.credential_json === "string" && psd.credential_json) ||
    (typeof credentials.accessToken === "string" && credentials.accessToken.startsWith("{")
      ? credentials.accessToken
      : "");
  if (!userId || !credentialJson) return null;
  return { userId, credentialJson };
}

export function clearZedJwtCache(connectionId?: string | null): void {
  if (connectionId) jwtCacheByConnection.delete(connectionId);
}

export async function fetchZedJwt(
  credentials: ProviderCredentials,
  signal?: AbortSignal | null
): Promise<string> {
  const cred = getZedCredentialAuth(credentials);
  if (!cred) {
    throw new Error("Zed Cloud credentials missing userId or credentialJson");
  }

  const cacheKey = credentials.connectionId || `${cred.userId}:${cred.credentialJson.slice(0, 32)}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = jwtCacheByConnection.get(cacheKey);
  if (cached && nowSec < cached.expSec - ZED_JWT_REFRESH_BUFFER_SEC) {
    return cached.token;
  }

  const authHeader = `${cred.userId} ${cred.credentialJson}`;
  const response = await fetch(ZED_CLOUD_URLS.llmTokens, {
    method: "POST",
    headers: {
      authorization: authHeader,
      "content-type": "application/json",
      "x-zed-system-id": ZED_SYSTEM_ID,
    },
    body: "",
    signal: signal ?? undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Zed Cloud token refresh failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as { token?: string };
  const token = data?.token;
  if (!token || typeof token !== "string") {
    throw new Error("Zed Cloud token response missing token field");
  }

  jwtCacheByConnection.set(cacheKey, {
    token,
    expSec: parseJwtExpSec(token) || nowSec + 3600,
  });

  return token;
}

export { ZED_SYSTEM_ID };
