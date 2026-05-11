export interface RelayHmacInput {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
  keyId: string;
}

export interface RelayHmacHeaders {
  keyId: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
  version: string;
  signature: string;
}

export function canonicalRelayString(input: RelayHmacInput): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.bodySha256.toLowerCase(),
    input.keyId,
  ].join("\n");
}

export async function signRelayRequest(input: RelayHmacInput, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalRelayString(input)));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseRelayHmacHeaders(headers: Headers): RelayHmacHeaders | { error: string } {
  const parsed = {
    keyId: headers.get("x-relay-key-id") ?? "",
    timestamp: headers.get("x-relay-timestamp") ?? "",
    nonce: headers.get("x-relay-nonce") ?? "",
    bodySha256: normalizeBodySha256(headers.get("x-relay-body-sha256") ?? ""),
    version: headers.get("x-relay-version") ?? "",
    signature: headers.get("x-relay-signature") ?? "",
  };

  for (const [name, value] of Object.entries(parsed)) {
    if (value.length === 0) {
      return { error: `missing_${toSnakeCase(name)}` };
    }
  }

  if (!/^[0-9]+$/.test(parsed.timestamp)) {
    return { error: "invalid_timestamp" };
  }
  if (!/^[0-9a-f]{64}$/.test(parsed.bodySha256)) {
    return { error: "invalid_body_sha256" };
  }

  return parsed;
}

export function normalizeBodySha256(value: string): string {
  return value.toLowerCase().startsWith("sha256:") ? value.slice("sha256:".length).toLowerCase() : value.toLowerCase();
}

export function timingSafeEqualString(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  let diff = leftBytes.byteLength ^ rightBytes.byteLength;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}
