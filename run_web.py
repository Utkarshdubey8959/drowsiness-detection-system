import json
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
PHONE_PATTERN = re.compile(r"^\+[1-9]\d{7,14}$")
MAX_REQUEST_SIZE = 8192
SMS_MESSAGE = "Alert: {name} appears to be drowsy."
CALL_MESSAGE = (
    "Drowsiness alert. {name} appears drowsy. Please contact them and, if they are driving, "
    "advise them to stop safely. Please wake up as soon as possible. Wake up, wake up, wake up."
)

load_dotenv(BASE_DIR / ".env")


def get_twilio_settings():
    settings = (
        os.getenv("TWILIO_ACCOUNT_SID", "").strip(),
        os.getenv("TWILIO_AUTH_TOKEN", "").strip(),
        os.getenv("TWILIO_PHONE_NUMBER", "").strip(),
    )
    if any(not value or value.lower().startswith("your_") for value in settings):
        return None
    return settings


class DrowsinessRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/status":
            self.send_json(200, {"twilioConfigured": get_twilio_settings() is not None})
            return
        if path.startswith("/api/"):
            self.send_json(404, {"error": "Not found."})
            return
        super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/api/alerts":
            self.send_json(404, {"error": "Not found."})
            return

        origin = urlsplit(self.headers.get("Origin", ""))
        if (
            origin.scheme not in ("http", "https")
            or not origin.netloc
            or origin.netloc.lower() != self.headers.get("Host", "").lower()
        ):
            self.send_json(403, {"error": "Requests must come from this web app."})
            return

        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Expected a JSON request."})
            return

        try:
            request_size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid request size."})
            return
        if request_size <= 0 or request_size > MAX_REQUEST_SIZE:
            self.send_json(413, {"error": "Request is empty or too large."})
            return

        try:
            payload = json.loads(self.rfile.read(request_size))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error": "Invalid JSON request."})
            return
        if not isinstance(payload, dict):
            self.send_json(400, {"error": "Invalid alert details."})
            return

        kind = payload.get("kind")
        name = payload.get("name", "")
        phone_number = payload.get("phone", "")
        message = payload.get("message", SMS_MESSAGE if kind == "sms" else CALL_MESSAGE)
        if kind not in ("sms", "call"):
            self.send_json(400, {"error": "Unknown alert type."})
            return
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
            self.send_json(400, {"error": "Enter a name of at most 80 characters."})
            return
        if not isinstance(phone_number, str) or not PHONE_PATTERN.fullmatch(phone_number.strip()):
            self.send_json(400, {"error": "Enter a recipient number in international format, such as +14155550123."})
            return
        message_limit = 500 if kind == "sms" else 1200
        if not isinstance(message, str) or not message.strip() or len(message.strip()) > message_limit:
            self.send_json(400, {"error": f"Message must be 1–{message_limit} characters."})
            return
        name = name.strip()
        phone_number = phone_number.strip()
        message = message.strip().replace("{name}", name)

        settings = get_twilio_settings()
        if settings is None:
            self.send_json(503, {"error": "Twilio is not configured on the server."})
            return

        try:
            from twilio.rest import Client

            account_sid, auth_token, twilio_phone = settings
            client = Client(account_sid, auth_token)
            if kind == "sms":
                result = client.messages.create(
                    body=message,
                    from_=twilio_phone,
                    to=phone_number,
                )
            else:
                from twilio.twiml.voice_response import VoiceResponse

                response = VoiceResponse()
                response.say(
                    message,
                    voice="alice",
                )
                result = client.calls.create(
                    twiml=str(response),
                    from_=twilio_phone,
                    to=phone_number,
                )
        except Exception as error:
            self.log_error("Twilio %s request failed: %s", kind, error)
            self.send_json(502, {"error": "Twilio could not send the alert. Check the server log."})
            return

        self.send_json(200, {"message": f"{kind.upper()} request accepted.", "id": result.sid})


def main():
    port = int(os.getenv("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), DrowsinessRequestHandler)
    print(f"Drowsiness Detection web app: http://127.0.0.1:{port}")
    print("Camera frames are processed in your browser and are not uploaded.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping web server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
