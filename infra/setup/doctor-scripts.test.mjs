import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("doctor scripts have valid shell syntax", () => {
  for (const script of ["infra/setup/doctor-local.sh", "infra/setup/doctor-delivery.sh"]) {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("doctor-delivery accepts pasted DKIM and DMARC pass headers", () => {
  const headers = [
    "Authentication-Results: mx.google.com;",
    " dkim=pass header.i=@alexmiller.net header.s=cf-bounce;",
    " spf=pass smtp.mailfrom=bounces@cf-bounce.alexmiller.net;",
    " dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=alexmiller.net",
    "",
  ].join("\n");
  const result = spawnSync("bash", ["infra/setup/doctor-delivery.sh", "--domain", "alexmiller.net"], {
    input: headers,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /DKIM pass: yes/);
  assert.match(result.stdout, /DMARC pass: yes/);
});

test("doctor-delivery rejects missing DMARC pass", () => {
  const headers = "Authentication-Results: mx.google.com; dkim=pass header.i=@alexmiller.net\n";
  const result = spawnSync("bash", ["infra/setup/doctor-delivery.sh", "--domain", "alexmiller.net"], {
    input: headers,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /DMARC pass: no/);
});
