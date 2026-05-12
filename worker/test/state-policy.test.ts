import { describe, expect, it } from "vitest";
import { senderAllowedForApiKey } from "../src/state";

describe("sender policy matching", () => {
  it("does not let domain wildcards match subdomains or trailing-dot variants", () => {
    const allowed = ["*@alexmiller.net"];

    expect(senderAllowedForApiKey("alex@alexmiller.net", allowed)).toBe(true);
    expect(senderAllowedForApiKey("alex@evil.alexmiller.net", allowed)).toBe(false);
    expect(senderAllowedForApiKey("alex@alexmiller.net.", allowed)).toBe(false);
    expect(senderAllowedForApiKey("alex@foo.alexmiller.net", ["*@.alexmiller.net"])).toBe(false);
  });
});
