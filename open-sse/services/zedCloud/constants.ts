/** Zed Cloud API constants (ported from zed2api). */

export const ZED_CLOUD_BASE_URL = "https://cloud.zed.dev";

export const ZED_CLOUD_URLS = {
  completions: `${ZED_CLOUD_BASE_URL}/completions`,
  models: `${ZED_CLOUD_BASE_URL}/models`,
  llmTokens: `${ZED_CLOUD_BASE_URL}/client/llm_tokens`,
  usersMe: `${ZED_CLOUD_BASE_URL}/client/users/me`,
} as const;

export const ZED_SIGNIN_URL = "https://zed.dev/native_app_signin";

/** Sent only on JWT refresh (llm_tokens). */
export const ZED_SYSTEM_ID = "6b87ab66-af2c-49c7-b986-ef4c27c9e1fb";

/** Default client build string; override via ZED_CLIENT_VERSION env. */
export const ZED_DEFAULT_CLIENT_VERSION =
  "0.222.4+stable.147.b385025df963c9e8c3f74cc4dadb1c4b29b3c6f0";

export function getZedClientVersion(): string {
  const fromEnv = process.env.ZED_CLIENT_VERSION?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : ZED_DEFAULT_CLIENT_VERSION;
}

/** JWT cache refresh buffer (seconds before exp). */
export const ZED_JWT_REFRESH_BUFFER_SEC = 60;
