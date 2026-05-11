const workerUrl = requiredEnv("CF_MAIL_RELAY_WORKER_URL");
const apiKey = requiredEnv("CF_MAIL_RELAY_API_KEY");
const from = requiredEnv("CF_MAIL_RELAY_FROM");
const to = requiredEnv("CF_MAIL_RELAY_TO");
const subject = process.env.CF_MAIL_RELAY_SUBJECT ?? "Test from cf-mail-relay HTTP API";
const body = process.env.CF_MAIL_RELAY_BODY ?? "hello from cf-mail-relay";
const idempotencyKey = process.env.CF_MAIL_RELAY_IDEMPOTENCY_KEY ?? crypto.randomUUID();

const mime = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${body}\r\n`;
const response = await fetch(`${workerUrl.replace(/\/$/, "")}/send`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  },
  body: JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64") }),
});

const payload = await response.json();
if (!response.ok || payload.ok === false) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(payload, null, 2));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}
