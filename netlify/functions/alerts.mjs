import {
  escapeXml,
  getTwilioConfig,
  isE164,
  jsonResponse,
  safelyMatchesSecret,
} from "../lib/shared.mjs";

const MAX_REQUEST_SIZE = 8192;
const DEFAULT_MESSAGES = {
  sms: "Alert: {name} appears to be drowsy.",
  call:
    "Drowsiness alert. {name} appears drowsy. Please contact them and, if they are driving, advise them to stop safely. Please wake up as soon as possible. Wake up, wake up, wake up.",
};

function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function submitToTwilio(kind, message, phone, config) {
  const account = encodeURIComponent(config.accountSid);
  const resource = kind === "sms" ? "Messages" : "Calls";
  const body = new URLSearchParams({
    To: phone,
    From: config.fromNumber,
  });
  if (kind === "sms") {
    body.set("Body", message);
  } else {
    body.set("Twiml", `<Response><Say voice="alice">${escapeXml(message)}</Say></Response>`);
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${account}/${resource}.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(8000),
    },
  );

  if (!response.ok) {
    console.error(`Twilio ${kind} request returned HTTP ${response.status}.`);
    return null;
  }

  const result = await response.json();
  return typeof result.sid === "string" ? result.sid : null;
}

export default async function alerts(request) {
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const config = getTwilioConfig();
  if (!config.ready) {
    return jsonResponse(503, { error: "Remote alerts are not configured on this site." });
  }
  if (!isSameOrigin(request)) {
    return jsonResponse(403, { error: "Requests must come from this site." });
  }
  if (!safelyMatchesSecret(request.headers.get("x-alert-access-code"), config.alertApiKey)) {
    return jsonResponse(401, { error: "Enter the site's remote alert access code." });
  }
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return jsonResponse(415, { error: "Expected a JSON request." });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_SIZE) {
    return jsonResponse(413, { error: "Request is too large." });
  }

  let payload;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_SIZE) {
      return jsonResponse(413, { error: "Request is too large." });
    }
    payload = JSON.parse(raw);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON request." });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonResponse(400, { error: "Invalid alert details." });
  }

  const { kind } = payload;
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const phone = typeof payload.phone === "string" ? payload.phone.trim() : "";
  if (kind !== "sms" && kind !== "call") {
    return jsonResponse(400, { error: "Unknown alert type." });
  }
  if (!name || name.length > 80) {
    return jsonResponse(400, { error: "Enter a name of at most 80 characters." });
  }
  if (!isE164(phone)) {
    return jsonResponse(400, { error: "Enter a recipient number in international format." });
  }
  if (!config.allowedRecipients.includes(phone)) {
    return jsonResponse(403, { error: "That recipient is not approved for alerts on this site." });
  }

  const message = typeof payload.message === "string"
    ? payload.message.trim()
    : DEFAULT_MESSAGES[kind];
  const messageLimit = kind === "sms" ? 500 : 1200;
  if (!message || message.length > messageLimit) {
    return jsonResponse(400, { error: `Message must be 1–${messageLimit} characters.` });
  }

  try {
    const sid = await submitToTwilio(kind, message.replaceAll("{name}", name), phone, config);
    if (!sid) {
      return jsonResponse(502, { error: "Twilio rejected the alert. Check the site's function logs." });
    }
    return jsonResponse(200, { message: `${kind.toUpperCase()} request accepted by Twilio.` });
  } catch (error) {
    console.error(`Twilio ${kind} request failed:`, error.message);
    return jsonResponse(502, { error: "Could not contact Twilio. Check the site's function logs." });
  }
}
