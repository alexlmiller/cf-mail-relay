import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const syncScript = path.join(repositoryRoot, "infra/docker/sync-certificates.sh");

function writeExecutable(file, contents) {
  writeFileSync(file, contents, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function createHarness(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cf-mail-relay-certificate-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const bin = path.join(root, "bin");
  const deployment = path.join(root, "deployment");
  const dockerLog = path.join(root, "docker.log");
  const cert = path.join(root, "certificate.pem");
  const key = path.join(root, "private-key.pem");
  mkdirSync(bin);
  mkdirSync(deployment);
  writeFileSync(cert, "test certificate\n");
  writeFileSync(key, "test private key\n");

  writeExecutable(
    path.join(bin, "install"),
    `#!/bin/sh
last=
for argument do
  last=$argument
done
/bin/mkdir -p "$last"
`,
  );
  writeExecutable(path.join(bin, "chown"), "#!/bin/sh\nexit 0\n");
  writeExecutable(
    path.join(bin, "openssl"),
    `#!/bin/sh
if [ "$1" = sha256 ]; then
  /bin/cat >/dev/null
  printf '%s\\n' 'SHA2-256(stdin)= test-public-key'
  exit 0
fi
case " $* " in
  *" -pubkey "*|*" -pubout "*) printf '%s\\n' 'test-public-key' ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >>"$DOCKER_LOG"
case " $* " in
  *" ps --status running --services "*)
    if [ -n "\${FAKE_RUNNING_SERVICES:-}" ]; then
      printf '%s\\n' "$FAKE_RUNNING_SERVICES"
    fi
    ;;
esac
`,
  );

  const run = (extraEnvironment = {}) =>
    spawnSync("/bin/sh", [syncScript, cert, key, deployment], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DOCKER_LOG: dockerLog,
        ...extraEnvironment,
      },
    });

  return { deployment, dockerLog, root, run };
}

test("publishes the renewed bundle and warns when the Compose file is absent", (t) => {
  const harness = createHarness(t);
  const result = harness.run();

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /Compose file .* was not found/);
  assert.match(result.stderr, /restart the relay/);
  assert.ok(existsSync(path.join(harness.deployment, "tls/relay.pem")));
});

test("publishes the renewed bundle and warns when the relay is stopped", (t) => {
  const harness = createHarness(t);
  writeFileSync(path.join(harness.deployment, "compose.yml"), "services: {}\n");

  const result = harness.run();
  const dockerLog = readFileSync(harness.dockerLog, "utf8");

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /relay service is not running/);
  assert.match(dockerLog, /ps --status running --services/);
  assert.doesNotMatch(dockerLog, /restart relay/);
});

test("uses RELAY_COMPOSE_FILE and restarts a running relay", (t) => {
  const harness = createHarness(t);
  const composeFile = path.join(harness.root, "custom-compose.yml");
  writeFileSync(composeFile, "services: {}\n");

  const result = harness.run({
    FAKE_RUNNING_SERVICES: "relay",
    RELAY_COMPOSE_FILE: composeFile,
  });
  const dockerLog = readFileSync(harness.dockerLog, "utf8");

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, "");
  assert.ok(dockerLog.includes(`-f ${composeFile} ps --status running --services`));
  assert.ok(dockerLog.includes(`-f ${composeFile} restart relay`));
});
