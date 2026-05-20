/**
 * Zed Cloud native app sign-in — RSA keypair + loopback callback.
 */

import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";

export type ZedRsaKeyPair = {
  publicKeyB64Url: string;
  privateKeyPem: string;
};

export function generateZedRsaKeyPair(): ZedRsaKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const publicKeyB64Url = publicKey.toString("base64url");
  return { publicKeyB64Url, privateKeyPem: privateKey };
}

export function buildZedSignInUrl(port: number, publicKeyB64Url: string): string {
  const params = new URLSearchParams({
    native_app_port: String(port),
    native_app_public_key: publicKeyB64Url,
  });
  return `https://zed.dev/native_app_signin?${params.toString()}`;
}

function decodeBase64Url(input: string): Buffer {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  if (pad) b64 += "=".repeat(pad);
  return Buffer.from(b64, "base64");
}

export function decryptZedAccessToken(privateKeyPem: string, ciphertextB64Url: string): string {
  const ciphertext = decodeBase64Url(ciphertextB64Url);
  const plaintext = privateDecrypt(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    ciphertext
  );
  return plaintext.toString("utf8");
}

export function parseZedCallbackCredential(
  userId: string,
  decryptedPlaintext: string
): { userId: string; credentialJson: string; email?: string } {
  let credentialJson = decryptedPlaintext.trim();
  let email: string | undefined;
  try {
    const parsed = JSON.parse(credentialJson) as Record<string, unknown>;
    credentialJson = JSON.stringify(parsed);
    if (typeof parsed.github_user_login === "string") email = parsed.github_user_login;
  } catch {
    // store raw string as credential JSON
  }
  return { userId, credentialJson, email };
}
