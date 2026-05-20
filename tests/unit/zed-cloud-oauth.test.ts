import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildZedSignInUrl,
  decryptZedAccessToken,
  generateZedRsaKeyPair,
  parseZedCallbackCredential,
} from "@/lib/oauth/services/zedCloud";
import { generateKeyPairSync, publicEncrypt, constants } from "node:crypto";

describe("zed-cloud oauth RSA", () => {
  it("builds native sign-in URL with port and public key", () => {
    const url = buildZedSignInUrl(54321, "abc123key");
    assert.ok(url.includes("native_app_port=54321"));
    assert.ok(url.includes("native_app_public_key=abc123key"));
    assert.ok(url.startsWith("https://zed.dev/native_app_signin"));
  });

  it("round-trips RSA-OAEP decrypt", () => {
    const { privateKeyPem, publicKeyB64Url } = generateZedRsaKeyPair();
    const plaintext = JSON.stringify({ github_user_login: "testuser", access_token: "tok" });
    const pubDer = Buffer.from(publicKeyB64Url, "base64url");
    const encrypted = publicEncrypt(
      {
        key: pubDer,
        format: "der",
        type: "pkcs1",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(plaintext, "utf8")
    );
    const cipherB64 = encrypted.toString("base64url");
    const decrypted = decryptZedAccessToken(privateKeyPem, cipherB64);
    assert.equal(decrypted, plaintext);
    const mapped = parseZedCallbackCredential("uid-1", decrypted);
    assert.equal(mapped.userId, "uid-1");
    assert.ok(mapped.credentialJson.includes("testuser"));
  });
});
