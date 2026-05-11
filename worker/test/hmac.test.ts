import vectors from "../../shared/test-vectors.json";
import { canonicalRelayString, signRelayRequest } from "../src/hmac";
import { describe, expect, it } from "vitest";

describe("relay HMAC contract", () => {
  for (const vector of vectors.vectors) {
    it(`matches ${vector.name}`, async () => {
      const input = {
        method: vector.method,
        path: vector.path,
        timestamp: vector.timestamp,
        nonce: vector.nonce,
        bodySha256: vector.body_sha256,
        keyId: vector.key_id,
      };

      expect(canonicalRelayString(input)).toBe(vector.canonical);
      await expect(signRelayRequest(input, vector.secret)).resolves.toBe(vector.signature);
    });
  }
});
