import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateChecks, main, parseArgs, parseRecipients, spikeUrl } from "./send-fixture.mjs";

describe("parseArgs", () => {
  it("parses required MS0 send options", () => {
    const options = parseArgs([
      "--fixture",
      "plain-text.eml",
      "--from",
      "sender@example.com",
      "--recipients",
      "one@example.net,two@example.org",
      "--worker-url",
      "https://worker.example.com",
      "--label",
      "Plain Text",
      "--live",
    ]);

    assert.equal(options.fixture, "plain-text.eml");
    assert.equal(options.from, "sender@example.com");
    assert.equal(options.recipients, "one@example.net,two@example.org");
    assert.equal(options.workerUrl, "https://worker.example.com");
    assert.equal(options.label, "plain-text");
    assert.equal(options.live, true);
  });

  it("rejects unknown options", () => {
    assert.throws(() => parseArgs(["--unknown"]), /Unknown option/);
  });
});

describe("spikeUrl", () => {
  it("builds a dry-run spike URL by default", () => {
    const url = spikeUrl({
      workerUrl: "https://worker.example.com",
      from: "sender@example.com",
      recipients: "one@example.net, two@example.org",
      live: false,
    });

    assert.equal(url.toString(), "https://worker.example.com/spike?from=sender%40example.com&recipients=one%40example.net%2Ctwo%40example.org&dry_run=1");
  });
});

describe("evaluateChecks", () => {
  it("evaluates evidence checks from the spike response", () => {
    assert.deepEqual(
      evaluateChecks(
        {
          ok: true,
          mime_sha256: "abc123",
          mime_round_trip_verified: true,
          dry_run: true,
        },
        "abc123",
        true,
      ),
      {
        worker_ok: true,
        mime_sha256_matches_local: true,
        mime_round_trip_verified: true,
        dry_run_matches_request: true,
      },
    );
  });
});

describe("parseRecipients", () => {
  it("trims empty recipient entries", () => {
    assert.deepEqual(parseRecipients(" one@example.net, ,two@example.org "), ["one@example.net", "two@example.org"]);
  });
});

describe("main", () => {
  it("writes evidence JSON for a dry-run request", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cf-mail-relay-ms0-"));
    const fixture = path.join(tempDir, "plain.eml");
    const outDir = path.join(tempDir, "evidence");
    const fixtureText = "From: sender@example.com\r\n\r\nHello\r\n";
    const fixtureSha256 = createHash("sha256").update(fixtureText).digest("hex");
    await writeFile(fixture, fixtureText);

    const fetchImpl = async (url, init) => {
      assert.equal(url.toString(), "https://worker.example.com/spike?from=sender%40example.com&recipients=one%40example.net&dry_run=1");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, "Bearer token");
      assert.equal(init.headers["content-type"], "message/rfc822");
      return new Response(
        JSON.stringify({
          ok: true,
          dry_run: true,
          mime_sha256: fixtureSha256,
          mime_round_trip_verified: true,
        }),
        { status: 200 },
      );
    };

    await main(
      [
        "--fixture",
        fixture,
        "--from",
        "sender@example.com",
        "--recipients",
        "one@example.net",
        "--worker-url",
        "https://worker.example.com",
        "--label",
        "plain",
        "--out-dir",
        outDir,
      ],
      { MS0_SPIKE_TOKEN: "token" },
      fetchImpl,
      () => {},
    );

    const entries = await readdir(outDir);
    assert.equal(entries.length, 1);
    const evidence = JSON.parse(await readFile(path.join(outDir, entries[0]), "utf8"));
    assert.equal(evidence.kind, "cf-mail-relay.ms0.spike-evidence");
    assert.equal(evidence.request.fixture_size_bytes, 35);
    assert.equal(evidence.checks.mime_sha256_matches_local, true);
  });
});
