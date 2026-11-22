import { timingSafeEqual } from "node:crypto";

const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

export function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function isE164(value) {
  return typeof value === "string" && PHONE_PATTERN.test(value);
}

export function getTwilioConfig(env = process.env) {
  const allowedRecipients = [...new Set(
    (env.TWILIO_ALLOWED_RECIPIENTS || "")
      .split(",")
      .map((number) => number.trim())
      .filter(isE164),
  )];
  const config = {
    accountSid: (env.TWILIO_ACCOUNT_SID || "").trim(),
    authToken: (env.TWILIO_AUTH_TOKEN || "").trim(),
    fromNumber: (env.TWILIO_PHONE_NUMBER || "").trim(),
    allowedRecipients,
    alertApiKey: (env.ALERT_API_KEY || "").trim(),
  };
  config.ready = Boolean(
    config.accountSid &&
    config.authToken &&
    isE164(config.fromNumber) &&
    config.allowedRecipients.length &&
    config.alertApiKey,
  );
  return config;
}

export function safelyMatchesSecret(provided, expected) {
  if (typeof provided !== "string" || !expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export function escapeXml(value) {
  return value.replace(/[<>&"']/g, (character) => {
    const entities = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character];
  });
}
