import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import alerts from "../netlify/functions/alerts.mjs";
import status from "../netlify/functions/status.mjs";

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "TWILIO_ALLOWED_RECIPIENTS",
  "ALERT_API_KEY",
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const configuredEnv = {
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "test-auth-token",
  TWILIO_PHONE_NUMBER: "+14155550100",
  TWILIO_ALLOWED_RECIPIENTS: "+14155550101,+14155550102",
  ALERT_API_KEY: "test-access-code",
};

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  globalThis.fetch = originalFetch;
}

function configureEnvironment(overrides = {}) {
  for (const key of ENV_KEYS) {
    const value = Object.hasOwn(overrides, key) ? overrides[key] : configuredEnv[key];
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = value;
  }
}

function alertRequest(payload, { code = "test-access-code", origin = "https://demo.netlify.app" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (code !== null) headers["X-Alert-Access-Code"] = code;
  if (origin !== null) headers.Origin = origin;
  return new Request("https://demo.netlify.app/api/alerts", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

afterEach(restoreEnvironment);

test("status exposes readiness without returning credentials", async () => {
  configureEnvironment();
  const response = await status(new Request("https://demo.netlify.app/api/status"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.twilioConfigured, true);
  assert.equal(body.requiresAccessCode, true);
  assert.equal(JSON.stringify(body).includes(configuredEnv.ALERT_API_KEY), false);
});

test("status reports remote alerts unavailable when secrets are missing", async () => {
  configureEnvironment({ ...configuredEnv, ALERT_API_KEY: null });
  const response = await status(new Request("https://demo.netlify.app/api/status"));
  assert.deepEqual(await response.json(), {
    twilioConfigured: false,
    requiresAccessCode: false,
    recipientRestricted: true,
  });
});

test("alerts reject requests without the access code", async () => {
  configureEnvironment();
  let outboundRequests = 0;
  globalThis.fetch = async () => {
    outboundRequests += 1;
    throw new Error("Twilio should not be contacted.");
  };
  const response = await alerts(alertRequest({
    kind: "sms", name: "Driver", phone: "+14155550101", message: "Help {name}",
  }, { code: null }));
  assert.equal(response.status, 401);
  assert.equal(outboundRequests, 0);
});

test("alerts reject unapproved recipients", async () => {
  configureEnvironment();
  const response = await alerts(alertRequest({
    kind: "sms", name: "Driver", phone: "+14155550199", message: "Help {name}",
  }));
  assert.equal(response.status, 403);
});

test("SMS templates substitute the name and call only the mocked Twilio endpoint", async () => {
  configureEnvironment();
  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestUrl = url;
    requestBody = new URLSearchParams(options.body);
    return new Response(JSON.stringify({ sid: "SM-test" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  const response = await alerts(alertRequest({
    kind: "sms",
    name: "Test Driver",
    phone: "+14155550101",
    message: "Alert for {name}",
  }));
  assert.equal(response.status, 200);
  assert.match(requestUrl, /Messages\.json$/);
  assert.equal(requestBody.get("Body"), "Alert for Test Driver");
  assert.equal(requestBody.get("To"), "+14155550101");
});

test("call text is XML-escaped before sending TwiML to the mocked endpoint", async () => {
  configureEnvironment();
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = new URLSearchParams(options.body);
    return new Response(JSON.stringify({ sid: "CA-test" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  const response = await alerts(alertRequest({
    kind: "call",
    name: "Test Driver",
    phone: "+14155550101",
    message: "Drowsy <name> & {name}",
  }));
  assert.equal(response.status, 200);
  assert.match(requestBody.get("Twiml"), /Drowsy &lt;name&gt; &amp; Test Driver/);
});
