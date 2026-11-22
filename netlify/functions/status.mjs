import { getTwilioConfig, jsonResponse } from "../lib/shared.mjs";

export default async function status(request) {
  if (request.method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const config = getTwilioConfig();
  return jsonResponse(200, {
    twilioConfigured: config.ready,
    requiresAccessCode: Boolean(config.alertApiKey),
    recipientRestricted: config.allowedRecipients.length > 0,
  });
}
