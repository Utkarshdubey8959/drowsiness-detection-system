# Drowsiness Detection System - Detailed Project Explanation

## 1. Project overview

This project is a real-time, camera-based prototype that looks for facial signs
associated with drowsiness. It uses a webcam, MediaPipe Face Mesh, OpenCV, and
geometric measurements of the eyes and mouth. When it detects a sustained
drowsiness condition, it escalates alerts in stages:

1. Play a local beep.
2. Save a frame and send an SMS through Twilio.
3. Place an automated voice call through Twilio.

The desktop interface is built with Tkinter. Face and alert processing runs
while the GUI is open, and OpenCV displays a separate live camera window.

This is a computer-vision prototype for a college project. It is not a medical
device, a driver-monitoring certification, or a replacement for rest, safe
driving practices, or other safety systems.

## 2. Problem statement and objectives

Fatigue can reduce attention and reaction time. A camera-based system can
continuously observe visible facial cues without requiring the user to wear a
sensor. This project demonstrates that approach with:

- **Face landmark detection:** Find a set of facial reference points in each
  camera frame.
- **Eye-closure measurement:** Estimate whether the eyes look closed using
  distances between eye landmarks.
- **Mouth-opening measurement:** Estimate whether the mouth is open, which can
  be a cue for yawning.
- **Simple head-pose cue:** Use the horizontal displacement between two face
  landmarks as a rough lateral-tilt indicator.
- **Temporal rules:** Require eye or mouth measurements to persist for a number
  of frames before acting on them.
- **Escalating notifications:** Use local sound first, then remote SMS and voice
  alerts.

## 3. Technologies and project files

| Component | Purpose |
|---|---|
| Python 3.11 | Runtime used by the project's VS Code virtual environment |
| Tkinter | Main desktop form and buttons |
| OpenCV (`cv2`) | Webcam access, color conversion, drawing overlays, showing frames, and saving a still image |
| MediaPipe Face Mesh | Detecting one face and returning normalized facial landmarks |
| SciPy | Euclidean-distance calculations used by the eye and mouth ratios |
| Pygame | Playing the local alarm sound |
| Pillow | Loading the optional GUI background image |
| Twilio Python SDK | Sending the SMS and initiating the automated call |
| python-dotenv | Loading Twilio configuration from `.env` |

Important project files:

- `main.py`: GUI, camera loop, measurements, alert rules, and Twilio requests.
- `requirements.txt`: Python packages required by the app.
- `.env`: Local Twilio credentials and sender number. This file is private and
  ignored by Git.
- `.env.example`: Safe template showing the required environment variable names.
- `audio/alert.wav`: Local beep used at alert stage 1.
- `captures/`: Destination for a still frame saved at alert stage 2.
- `.vscode/launch.json`: VS Code launch configuration.
- `shape_predictor_68_face_landmarks.dat`: Legacy model file; the current code
  uses MediaPipe and does not load this file.

## 4. System architecture and data flow

The main processing path is:

```text
Tkinter form
    |
    +-- user name and recipient phone number
    |
Start detection
    |
OpenCV reads webcam frame (BGR)
    |
Convert frame to RGB
    |
MediaPipe Face Mesh finds face landmarks
    |
Convert selected normalized landmark coordinates to pixels
    |
Calculate EAR, MAR, and rough head direction
    |
Apply temporal thresholds and drowsiness rules
    |
Draw status text and show live frame
    |
Escalate: local beep -> screenshot and SMS -> voice call
```

The image is processed locally for landmark calculations. The program does not
stream the camera video to Twilio. At stage 2, it saves a local JPEG in
`captures/`; the SMS text contains the user's name and alert message, not the
image.

## 5. Face Mesh and landmark coordinates

At startup, `main.py` creates a MediaPipe Face Mesh object with:

- `max_num_faces=1`: process at most one face.
- `refine_landmarks=True`: request more detailed eye-region landmarks.
- Detection and tracking confidence thresholds of `0.5`.

OpenCV returns a BGR image. MediaPipe expects RGB, so each frame is converted
before processing. Each landmark has normalized `x` and `y` values, generally
expressed relative to the image width and height. The code converts a point to
pixel coordinates with:

```text
pixel_x = landmark.x * frame_width
pixel_y = landmark.y * frame_height
```

Distances are then measured in pixels. The ratios used for EAR and MAR are
dimensionless, so uniformly changing the image scale tends to cancel out in
the ratio. The head-direction rule, however, uses a fixed pixel threshold and
therefore changes with image scale and camera distance.

The current landmark selections are:

- Left eye: `[33, 160, 158, 133, 153, 144]`
- Right eye: `[263, 387, 385, 362, 380, 373]`
- Mouth: `[61, 291, 39, 181, 0, 17, 269, 405]`
- Nose reference: landmark `1`
- Chin reference: landmark `152`

These are MediaPipe Face Mesh indices; they are not the point numbers from the
legacy 68-point dlib predictor.

## 6. Eye Aspect Ratio (EAR)

The eye aspect ratio estimates how open an eye is from six points arranged
around its contour. In the conventional notation, let `p1` through `p6` be the
ordered points around the eye. The code uses the equivalent expression:

```text
EAR = (distance(p2, p6) + distance(p3, p5))
      / (2 * distance(p1, p4))
```

The numerator measures two vertical eye openings. The denominator measures
eye width. When the eyelids close, the vertical distances shrink while the
horizontal width changes less, so EAR generally decreases.

The project calculates an EAR for each eye and averages them:

```text
average_EAR = (left_EAR + right_EAR) / 2
```

The code treats `average_EAR < 0.25` as a low-eye-openness frame. It increments
`ear_counter` while the condition remains true and resets that counter when a
face is detected with EAR at or above the threshold.

If low EAR persists for at least 32 processed face frames, that rule marks
drowsiness. The actual elapsed time depends on frame rate:

```text
required_time_seconds ~= 32 / processed_frames_per_second
```

For example, at 30 processed frames per second, 32 frames is approximately
1.1 seconds. This is an estimate, not a guaranteed duration; camera and model
processing rates vary.

## 7. Mouth Aspect Ratio (MAR)

The mouth ratio estimates mouth opening using the selected mouth points:

```text
horizontal = distance(left_mouth_corner, right_mouth_corner)

MAR = (
    distance(mouth_points[2], mouth_points[3])
  + distance(mouth_points[4], mouth_points[5])
  + distance(mouth_points[6], mouth_points[7])
) / (3 * horizontal)
```

The three vertical distances sample mouth opening at different positions. The
average vertical opening is divided by mouth width. A larger value indicates a
more open mouth in this simplified measurement.

The project increments `mar_counter` when `MAR > 0.6`, and resets it when the
ratio is at or below the threshold. Fifteen consecutive qualifying face frames
make the MAR rule mark drowsiness. At 30 frames per second, 15 frames is about
half a second.

The preview draws the `Yawning Detected` label after the counter has reached
its threshold. The drowsiness rule uses that same sustained high-MAR condition.
This is only a mouth-opening heuristic: speech, singing, expressions, or other
actions may also open the mouth.

## 8. Rough head-direction heuristic

The code reads the nose and chin x-coordinates and calculates:

```text
dx = chin_x - nose_x
```

It reports:

- `dx > 15`: `Head Tilt Right`
- `dx < -15`: `Head Tilt Left`
- Otherwise: `Head Centered`

If the eyes have a low EAR in the current frame and this rule says the head is
tilted, the system immediately marks drowsiness without waiting for the
32-frame EAR counter.

This is a very rough heuristic, not a full head-pose estimator. A real face's
nose and chin do not always share the same horizontal coordinate in the image.
Turning the face, camera angle, perspective, and face position can all affect
`dx`. The rule does not calculate pitch, yaw, roll, or a head-tilt angle, and
the fixed 15-pixel threshold is not normalized by face size. Its displayed
direction should therefore not be treated as a reliable measurement of head
pose.

## 9. Drowsiness decision logic

For every frame in which Face Mesh returns a face, the code evaluates these
three alternatives:

```text
drowsy_detected =
    (ear_counter >= 32)
    OR (mar_counter >= 15)
    OR (current_EAR < 0.25 AND head_is_tilted)
```

The rules are combined with logical OR. Any one of them is enough to activate
the alert state. This increases the chance that one cue will catch an event,
but can also increase false alarms. For instance, yawning or a face turn might
be incorrectly interpreted as drowsiness.

When no face is found, the code does not calculate ratios for that frame. In
the current implementation the EAR and MAR counters are not explicitly reset
on a missing-face frame; they retain their previous values until a face is
detected again. This is a known limitation if the face frequently leaves the
camera view.

## 10. Three-stage alert state machine

The alert state uses:

- `drowsy_stage_counter`: how many alert stages have been reached in the
  current episode.
- `last_alert_time`: time of the latest stage.
- `ALERT_COOLDOWN = 10`: minimum seconds between stage increments.
- `sms_sent` and `call_started`: prevent duplicate SMS/call requests during the
  same episode.

When drowsiness is detected and more than 10 seconds have elapsed since the
previous stage, the stage counter advances:

| Stage | Current behavior |
|---|---|
| 1 | Overlay a warning, play `audio/alert.wav`, and print a status message. |
| 2 | Overlay the drowsiness alert, save a JPEG to `captures/`, and start the SMS request on a background thread. |
| 3 and later | Show the phone-alert overlay and start one Twilio voice call on a background thread. The `call_started` flag prevents repeated calls in that episode. |

If drowsiness remains continuously detected, the stages are spaced by at least
10 seconds. Therefore stage 2 is normally reached about 10 seconds after stage
1, and stage 3 about 20 seconds after stage 1. These are approximate because
the rules are evaluated on camera frames and the cooldown uses wall-clock time.

The episode resets only after the program sees a non-drowsy face and more than
20 seconds have passed since the previous alert. At reset, the stage count and
SMS/call guards are cleared. A new episode can then trigger alerts again.

SMS and calls run on background threads so the network request does not
intentionally block the camera loop. The app marks the SMS/call guard before
the request completes. If Twilio rejects a request, it prints the error in the
terminal, but this implementation does not automatically retry the failed
request during that episode.

## 11. Twilio integration

Twilio is used as the phone-network service; it is not part of the visual
recognition model. The program reads these values from `.env` in the project
folder:

```text
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
```

`TWILIO_PHONE_NUMBER` is the Twilio sender number. The recipient number is
entered in the app's `Phone (+CountryCode)` field. The SMS text is:

```text
Alert: <user name> appears to be drowsy.
```

For a call, the app generates TwiML and asks Twilio to speak a short
drowsiness-alert sentence. The call is an ordinary phone call initiated by
Twilio; it can incur account charges and is subject to account, sender-number,
destination-country, and trial-account restrictions.

Keep `.env` private. It is listed in `.gitignore`; do not paste its values into
chat, documentation, screenshots, source code, or a public repository. If the
credentials are exposed, rotate the Auth Token in Twilio.

The live integration was checked using one test SMS and one short test call.
Twilio reported the SMS as delivered and the call as completed at that time.
That confirms the configured account and sender worked for that test, but does
not guarantee future carrier delivery, call pickup, or delivery under all
network conditions.

## 12. Running the application

### In Visual Studio Code

1. Open the project folder.
2. Select `.venv\Scripts\python.exe` as the Python interpreter if VS Code has
   not selected it automatically.
3. Press **F5** and choose **Run Drowsiness Detection**.
4. Enter a name and a recipient phone number in international format (for
   example, `+14155550123`).
5. Select **Start Detection** and allow camera access if prompted.
6. Use **Stop Detection** to end camera processing, or **Exit** to close the
   application.

The app also requires access to the default camera (device index `0`), a working
audio output, and network access for Twilio. It displays the video in a
separate OpenCV window. Pressing `q` closes the video loop; using **Stop
Detection** is the normal way to return the interface to its idle state.

### Recreate the Python environment

From PowerShell in the project folder:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The computer must also have a Python 3.11 installation. The `.venv` is local to
this machine and should not be committed.

## 13. Testing and demonstration plan

For a college demonstration, separate tests into visual detection, alert
progression, and network delivery:

1. **Startup test:** Confirm the Tkinter window opens and that the camera window
   displays frames.
2. **Face test:** Put one face in view and check that Face Mesh returns usable
   landmarks. Move out of view and observe that metric overlays stop updating.
3. **Eye test:** Compare the displayed behavior with open eyes and a sustained
   eye closure. Explain that the threshold is a heuristic and not a calibrated
   fatigue measurement.
4. **Mouth test:** Open the mouth for a sustained interval and observe the
   yawning label and MAR-based condition.
5. **Head heuristic test:** Move/turn the face and show how the displayed
   direction changes. Explain that this is a rough x-coordinate rule.
6. **Alert progression test:** Keep a test drowsiness condition present long
   enough to reach each stage. The cooldown means later stages take time.
7. **Capture test:** After stage 2, check `captures/` for the timestamped JPEG.
8. **Twilio test:** Use an authorized recipient and check the Twilio message and
   call logs. Tests may incur charges.
9. **Recovery test:** Return to normal visible face conditions and wait for the
   20-second reset condition before testing a new episode.

Do not deliberately test this system while driving or in another hazardous
setting. Use a stationary, controlled environment and an authorized recipient
for any real SMS or call.

## 14. Limitations and sources of error

- **Lighting:** Dark scenes, backlighting, shadows, and glare can make facial
  landmarks unstable.
- **Occlusion:** Sunglasses, masks, hands, hair, or objects can hide relevant
  landmarks.
- **Camera placement:** Extreme angles, distance, and camera movement affect
  landmark quality and the fixed pixel head-direction threshold.
- **Face orientation:** The current head rule can confuse turning the head with
  tilting it.
- **Threshold calibration:** `EAR_THRESHOLD`, `MAR_THRESHOLD`, frame counts,
  and cooldown are hard-coded and not personalized to a user or camera.
- **Frame-rate variation:** Frame-count thresholds do not correspond to a fixed
  duration when processing speed changes.
- **False positives:** Yawning, speaking, facial expression, or temporary
  tracking noise can satisfy a rule.
- **False negatives:** A user may be drowsy without closing their eyes,
  yawning, or producing the measured head cue.
- **One face only:** The detector is configured for at most one face.
- **No-face counter behavior:** The current code does not clear eye/mouth
  counters when a face is missing.
- **No clinical validation:** The rules do not diagnose sleepiness or measure
  a person's medical condition.
- **Network dependency:** SMS/call failures can occur because of connectivity,
  Twilio account status, destination restrictions, verification, or carrier
  delivery. The app logs failures but does not retry automatically.
- **No guaranteed emergency response:** SMS delivery and a completed call do
  not guarantee that a person sees, answers, or acts on the alert.

For safety, this prototype must not be used as the sole means of preventing
accidents or as proof that a person is safe to drive.

## 15. Possible future improvements

- Calibrate EAR and MAR per user during a short setup period instead of relying
  on one fixed threshold.
- Use a time-based rolling window or a smoothed metric to reduce sensitivity
  to one-frame tracking noise.
- Reset or carefully preserve counters when no face is detected; track missing
  face duration separately.
- Estimate head pose with a normalized 3D pose method instead of a fixed
  nose/chin x-coordinate difference.
- Make camera selection, thresholds, and alert timing configurable.
- Use a separate alert log with timestamps and explicit success/failure states.
- Add retry/backoff rules for transient Twilio failures, with safeguards against
  duplicate messages and calls.
- Add unit tests for the EAR/MAR calculations and state-machine transitions.
- Evaluate the system on a representative, consented dataset and report
  precision, recall, false-positive rate, and latency before making performance
  claims.
- Add a clear shutdown path that releases the camera and closes MediaPipe when
  the GUI exits.

## 16. Suggested explanation for a project presentation

> The system captures frames from a webcam using OpenCV and passes RGB frames
> to MediaPipe Face Mesh. It extracts eye and mouth landmarks, computes the Eye
> Aspect Ratio and Mouth Aspect Ratio, and checks whether those measurements
> cross configured thresholds for enough consecutive frames. A simple
> nose-to-chin horizontal displacement rule provides an additional cue. These
> cues are combined with OR logic to produce a drowsiness state. A staged
> alert controller first plays a local sound, then saves a frame and sends an
> SMS, and finally places an automated call through Twilio. The thresholds are
> heuristic and the application is a prototype, so accuracy and safety are
> limited by lighting, face tracking, calibration, connectivity, and the lack
> of clinical validation.
