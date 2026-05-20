import { ZED_CLOUD_CONFIG } from "../constants/oauth";
import {
  buildZedSignInUrl,
  decryptZedAccessToken,
  generateZedRsaKeyPair,
  parseZedCallbackCredential,
} from "../services/zedCloud";

/**
 * Zed Cloud OAuth — native app RSA sign-in (zed.dev/native_app_signin).
 * Requires loopback callback server started via /api/oauth/zed-cloud/start-callback-server.
 *
 * Fallback: paste credential JSON + user_id from zed2api `login` output.
 */
export const zedCloud = {
  config: ZED_CLOUD_CONFIG,
  flowType: "native_app_rsa" as const,
  callbackPath: ZED_CLOUD_CONFIG.callbackPath,
  callbackPort: ZED_CLOUD_CONFIG.callbackPort,

  buildAuthUrl: (
    config: typeof ZED_CLOUD_CONFIG,
    _redirectUri: string,
    _state: string,
    _codeChallenge: string | null,
    extras?: { port?: number; publicKeyB64Url?: string }
  ) => {
    const port = extras?.port ?? 0;
    const pub = extras?.publicKeyB64Url ?? "";
    if (!port || !pub) return null;
    return buildZedSignInUrl(port, pub);
  },

  /**
   * Exchange callback params (user_id + encrypted access_token) for stored credentials.
   */
  exchangeToken: async (
    _config: typeof ZED_CLOUD_CONFIG,
    code: string,
    _redirectUri: string,
    codeVerifier: string,
    _state?: string,
    extras?: { userId?: string; privateKeyPem?: string }
  ) => {
    const userId = extras?.userId ?? "";
    const privateKeyPem = extras?.privateKeyPem ?? codeVerifier;
    if (!userId || !privateKeyPem) {
      throw new Error("Zed Cloud exchange requires userId and privateKeyPem");
    }
    const plaintext = decryptZedAccessToken(privateKeyPem, code);
    return { userId, plaintext };
  },

  mapTokens: (tokens: {
    userId?: string;
    plaintext?: string;
    credentialJson?: string;
    email?: string;
    authMethod?: string;
  }) => {
    if (tokens.credentialJson && tokens.userId) {
      return {
        accessToken: tokens.credentialJson,
        refreshToken: null,
        expiresIn: 0,
        email: tokens.email ?? null,
        providerSpecificData: {
          userId: tokens.userId,
          credentialJson: tokens.credentialJson,
          authMethod: tokens.authMethod || "import",
        },
      };
    }
    const userId = tokens.userId ?? "";
    const plaintext = tokens.plaintext ?? "";
    const parsed = parseZedCallbackCredential(userId, plaintext);
    return {
      accessToken: parsed.credentialJson,
      refreshToken: null,
      expiresIn: 0,
      email: parsed.email ?? tokens.email ?? null,
      providerSpecificData: {
        userId: parsed.userId,
        credentialJson: parsed.credentialJson,
        authMethod: tokens.authMethod || "browser",
      },
    };
  },
};
