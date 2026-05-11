import { describe, expect, it } from "vitest";
import { smtpCodeFor } from "../src/smtp-error-map";

describe("smtpCodeFor", () => {
  it("maps accepted sends to a success status", () => {
    expect(smtpCodeFor.accepted).toBe("250 2.0.0 Ok");
  });

  it("maps all-bounced sends to a permanent recipient failure", () => {
    expect(smtpCodeFor.all_bounced).toBe("550 5.1.1 No valid recipients accepted");
  });
});
