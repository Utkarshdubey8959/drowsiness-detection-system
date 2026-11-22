# Drowsiness Detection System

The project now includes a browser-based web app. Face landmark detection runs
locally in the browser; the camera stream is not uploaded. The Python server
serves the app and, when configured, sends SMS and voice alerts through Twilio.

**Live website:** <https://drowsiness-detection-system-web.netlify.app>

The hosted camera detector is available, but SMS and voice alerts are disabled
until Twilio credentials, an approved-recipient list, and an access code are
configured in Netlify.

## Run the web app

From PowerShell in this folder:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe run_web.py
```

Open <http://127.0.0.1:8000>. The browser needs an internet connection to load
the MediaPipe runtime and face landmark model, and camera permission must be
allowed. Camera access is restricted to `localhost` or a secure HTTPS site by
modern browsers.

## Deploy to Netlify

The Netlify deployment publishes the `web/` frontend and uses Netlify
Functions for Twilio requests. `run_web.py` is only for local use. The
`netlify.toml` build command runs the automated function tests before
publishing. Run the same tests locally with `npm test`; they mock Twilio and do
not send real messages or calls.

1. Push this project folder to a Git provider such as GitHub, then import that
   repository in Netlify. Netlify reads the build and function settings from
   `netlify.toml`. Manual drag-and-drop deploys only the static page and will
   not include the alert functions.
2. In Netlify site environment variables, set `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER`.
3. Set `TWILIO_ALLOWED_RECIPIENTS` to the approved E.164 numbers, comma
   separated (for example, `+14155550123,+14155550124`).
4. Set `ALERT_API_KEY` to a long, random access code and share it only with
   intended users. They enter it in the web app to enable remote alerts.
5. Redeploy after setting environment variables. Open the site's HTTPS URL and
   allow camera access.

The function refuses unapproved recipient numbers and never returns Twilio
credentials to the browser. The shared access code is a basic deployment gate,
not per-user authentication; use an authenticated service before offering
unrestricted public access. Never commit actual credentials or access codes.

## Twilio alerts

1. Copy `.env.example` to `.env`.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` in
   `.env` using your Twilio account values.
3. Restart the web server.

The first alert plays a loud pulsed tone. The web app's **Customize alerts &
timings** panel lets each user set the delay to SMS, the delay from SMS to the
call, enable or disable SMS/calls, edit their messages, set retry interval and
count, alarm volume and time limit, and choose how long normal detection must
last to clear an episode. Settings are saved in that browser. Defaults send
the SMS 5 seconds after the first warning and start the call 5 seconds after
the SMS stage (10 seconds total). Use **Test sound** to check the speaker and
device volume.

The second stage can send a customizable SMS and prepares a snapshot that you
can download. The third can place an automated voice call with the message set
in the alert settings. While drowsiness continues, accepted remote alerts can be
retried up to twice by default; retries stop when the face appears alert for
the configured recovery interval. Failed requests are shown in the Activity
panel and are not automatically retried. Enter the recipient phone in
international format (for example, `+14155550123`). Twilio usage may incur
charges and is subject to account, sender-number, and recipient restrictions.

Keep `.env` private and never put Twilio credentials in browser code. The web
server binds to `127.0.0.1` by default. Before exposing it to other users or
deploying it publicly, add authentication and rate limiting to the alert API,
use HTTPS, and configure Twilio credentials in the hosting provider's secret
manager.

## Notes

- The browser app is a prototype, not a certified driver-monitoring or medical
  safety system. Test only in a stationary, controlled environment.
- Drowsiness thresholds are heuristic and may produce false alarms or miss
  signs of drowsiness. Do not rely on this app to decide whether it is safe to
  drive.
- `main.py` remains available as the original Tkinter desktop version.
