import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";

const VISION_VERSION = "0.10.35";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const EAR_THRESHOLD = 0.25;
const MAR_THRESHOLD = 0.6;
const EAR_CONSEC_FRAMES = 32;
const MAR_CONSEC_FRAMES = 15;
const ALARM_PULSE_INTERVAL = 900;
const SETTINGS_KEY = "drowsiness-alert-settings";
const DEFAULT_ALERT_SETTINGS = Object.freeze({
  smsEnabled: true,
  callEnabled: true,
  smsMessage: "Alert: {name} appears to be drowsy.",
  callMessage:
    "Drowsiness alert. {name} appears drowsy. Please contact them and, if they are driving, advise them to stop safely. Please wake up as soon as possible. Wake up, wake up, wake up.",
  smsDelaySeconds: 5,
  callDelaySeconds: 5,
  retryDelaySeconds: 60,
  retryLimit: 2,
  alarmLimitSeconds: 120,
  recoverySeconds: 5,
  alarmVolume: 80,
});

const elements = {
  name: document.querySelector("#name-input"),
  phone: document.querySelector("#phone-input"),
  accessCode: document.querySelector("#alert-access-code"),
  accessCodeLabel: document.querySelector("#alert-access-code-label"),
  start: document.querySelector("#start-button"),
  stop: document.querySelector("#stop-button"),
  testSound: document.querySelector("#test-sound-button"),
  smsDelay: document.querySelector("#sms-delay"),
  callDelay: document.querySelector("#call-delay"),
  retryDelay: document.querySelector("#retry-delay"),
  retryLimit: document.querySelector("#retry-limit"),
  smsEnabled: document.querySelector("#sms-enabled"),
  callEnabled: document.querySelector("#call-enabled"),
  smsMessage: document.querySelector("#sms-message"),
  callMessage: document.querySelector("#call-message"),
  alarmLimit: document.querySelector("#alarm-limit"),
  recoveryDelay: document.querySelector("#recovery-delay"),
  alarmVolume: document.querySelector("#alarm-volume"),
  alarmVolumeValue: document.querySelector("#alarm-volume-value"),
  saveSettings: document.querySelector("#save-settings"),
  settingsStatus: document.querySelector("#settings-status"),
  stage2Detail: document.querySelector("#stage-2-detail"),
  stage3Detail: document.querySelector("#stage-3-detail"),
  status: document.querySelector("#app-status"),
  twilioStatus: document.querySelector("#twilio-status"),
  camera: document.querySelector("#camera"),
  overlay: document.querySelector("#overlay"),
  placeholder: document.querySelector("#camera-placeholder"),
  cameraState: document.querySelector("#camera-state"),
  faceStatus: document.querySelector("#face-status"),
  ear: document.querySelector("#ear-value"),
  mar: document.querySelector("#mar-value"),
  head: document.querySelector("#head-value"),
  stageCount: document.querySelector("#stage-count"),
  alertBanner: document.querySelector("#alert-banner"),
  alertMessage: document.querySelector("#alert-message"),
  activity: document.querySelector("#activity-log"),
  snapshot: document.querySelector("#snapshot-download"),
};

let faceLandmarker;
let cameraStream;
let animationFrame;
let audioContext;
let running = false;
let earCounter = 0;
let marCounter = 0;
let alertStage = 0;
let lastTimestamp = 0;
let lastProcessedAt = 0;
let snapshotUrl;
let userName = "";
let phoneNumber = "";
let alarmActive = false;
let alarmTimedOut = false;
let alarmInterval;
let alarmTimeout;
let normalSince = null;
let drowsinessStartedAt = 0;
let episodeId = 0;
let notificationAttempts = { sms: 0, call: 0 };
let retryTimers = { sms: null, call: null };
let alertSettings = { ...DEFAULT_ALERT_SETTINGS };
let episodeSettings = { ...DEFAULT_ALERT_SETTINGS };

const leftEyeIndices = [33, 160, 158, 133, 153, 144];
const rightEyeIndices = [263, 387, 385, 362, 380, 373];
const mouthIndices = [61, 291, 39, 181, 0, 17, 269, 405];

function setStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.className = `app-status${kind ? ` ${kind}` : ""}`;
}

function readAlertSettings() {
  function readInteger(input, minimum, maximum, label) {
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
    }
    return value;
  }

  return {
    smsEnabled: elements.smsEnabled.checked,
    callEnabled: elements.callEnabled.checked,
    smsMessage: elements.smsMessage.value.trim(),
    callMessage: elements.callMessage.value.trim(),
    smsDelaySeconds: readInteger(elements.smsDelay, 1, 60, "SMS delay"),
    callDelaySeconds: readInteger(elements.callDelay, 1, 60, "Call delay"),
    retryDelaySeconds: readInteger(elements.retryDelay, 10, 600, "Retry interval"),
    retryLimit: readInteger(elements.retryLimit, 0, 2, "Retry count"),
    alarmLimitSeconds: readInteger(elements.alarmLimit, 15, 120, "Alarm limit"),
    recoverySeconds: readInteger(elements.recoveryDelay, 3, 15, "Recovery time"),
    alarmVolume: readInteger(elements.alarmVolume, 50, 100, "Alarm volume"),
  };
}

function validateAlertSettings(settings) {
  if (settings.smsEnabled && (!settings.smsMessage || settings.smsMessage.length > 500)) {
    throw new Error("SMS message must be 1–500 characters when SMS is enabled.");
  }
  if (settings.callEnabled && (!settings.callMessage || settings.callMessage.length > 1200)) {
    throw new Error("Call message must be 1–1200 characters when calls are enabled.");
  }
  return settings;
}

function fillSettingsInputs(settings) {
  elements.smsEnabled.checked = settings.smsEnabled;
  elements.callEnabled.checked = settings.callEnabled;
  elements.smsMessage.value = settings.smsMessage;
  elements.callMessage.value = settings.callMessage;
  elements.smsDelay.value = settings.smsDelaySeconds;
  elements.callDelay.value = settings.callDelaySeconds;
  elements.retryDelay.value = settings.retryDelaySeconds;
  elements.retryLimit.value = settings.retryLimit;
  elements.alarmLimit.value = settings.alarmLimitSeconds;
  elements.recoveryDelay.value = settings.recoverySeconds;
  elements.alarmVolume.value = settings.alarmVolume;
  elements.alarmVolumeValue.textContent = `${settings.alarmVolume}%`;
}

function updateStageTimingLabels(settings) {
  const retryText = settings.retryLimit === 0
    ? "no retries"
    : `up to ${settings.retryLimit} retries`;
  elements.stage2Detail.textContent =
    settings.smsEnabled
      ? `${settings.smsDelaySeconds}s after warning; ${retryText}`
      : "SMS disabled";
  elements.stage3Detail.textContent =
    settings.callEnabled
      ? `${settings.smsDelaySeconds + settings.callDelaySeconds}s total; ${retryText}`
      : "Calls disabled";
}

function loadAlertSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (saved && typeof saved === "object") {
      fillSettingsInputs({ ...DEFAULT_ALERT_SETTINGS, ...saved });
      alertSettings = validateAlertSettings(readAlertSettings());
    } else {
      fillSettingsInputs(DEFAULT_ALERT_SETTINGS);
    }
  } catch (error) {
    fillSettingsInputs(DEFAULT_ALERT_SETTINGS);
    elements.settingsStatus.textContent = `Using defaults: ${error.message}`;
  }
  episodeSettings = { ...alertSettings };
  updateStageTimingLabels(alertSettings);
}

function saveAlertSettings() {
  try {
    const settings = validateAlertSettings(readAlertSettings());
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    alertSettings = settings;
    fillSettingsInputs(alertSettings);
    updateStageTimingLabels(alertSettings);
    elements.settingsStatus.textContent = "Saved on this device. Applies to the next alert episode.";
  } catch (error) {
    elements.settingsStatus.textContent = error.message;
  }
}

function addActivity(message) {
  const emptyMessage = elements.activity.querySelector(".empty-activity");
  if (emptyMessage) emptyMessage.remove();

  const entry = document.createElement("li");
  const time = document.createElement("time");
  const text = document.createElement("span");
  time.textContent = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(new Date());
  text.textContent = message;
  entry.append(time, text);
  elements.activity.prepend(entry);
  while (elements.activity.children.length > 12) {
    elements.activity.lastElementChild.remove();
  }
}

function setCameraState(isLive) {
  elements.cameraState.classList.toggle("is-live", isLive);
  elements.cameraState.innerHTML = `<span class="state-dot"></span> ${isLive ? "Camera on" : "Camera off"}`;
  document.querySelector(".live-indicator").classList.toggle("is-live", isLive);
}

function setAlert(stage, message, kind) {
  const visibleStage = Math.min(stage, 3);
  elements.stageCount.textContent = `${visibleStage} / 3`;
  elements.alertMessage.textContent = message;
  elements.alertBanner.className = `alert-banner${kind ? ` ${kind}` : ""}`;
  elements.alertBanner.querySelector(".alert-symbol").textContent = stage ? "!" : "✓";
  for (let index = 1; index <= 3; index += 1) {
    const item = document.querySelector(`#stage-${index}`);
    item.classList.toggle("is-complete", index < stage || (stage > 3 && index === 3));
    item.classList.toggle("is-active", index === visibleStage && stage <= 3);
  }
}

function clearNotificationRetries() {
  for (const kind of ["sms", "call"]) {
    if (retryTimers[kind] !== null) {
      window.clearTimeout(retryTimers[kind]);
      retryTimers[kind] = null;
    }
  }
}

function beginAlertEpisode(settings = alertSettings) {
  episodeId += 1;
  clearNotificationRetries();
  notificationAttempts = { sms: 0, call: 0 };
  alarmTimedOut = false;
  episodeSettings = { ...settings };
}

function resetEpisode() {
  beginAlertEpisode();
  stopAlarm();
  alertStage = 0;
  drowsinessStartedAt = 0;
  setAlert(0, "No alert. Detection is standing by.", "");
  addActivity("Drowsiness episode cleared.");
}

function distance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function calculateEar(landmarks, indices) {
  const points = indices.map((index) => landmarks[index]);
  const width = distance(points[0], points[3]);
  if (width === 0) return 0;
  return (distance(points[1], points[5]) + distance(points[2], points[4])) / (2 * width);
}

function calculateMar(landmarks) {
  const points = mouthIndices.map((index) => landmarks[index]);
  const width = distance(points[0], points[1]);
  if (width === 0) return 0;
  return (
    distance(points[2], points[3]) +
    distance(points[4], points[5]) +
    distance(points[6], points[7])
  ) / (3 * width);
}

function getHeadDirection(landmarks) {
  const nose = landmarks[1];
  const chin = landmarks[152];
  const dx = (chin.x - nose.x) * elements.camera.videoWidth;
  if (dx > 15) return "Right";
  if (dx < -15) return "Left";
  return "Centered";
}

function drawOverlay(message, color) {
  const canvas = elements.overlay;
  const width = elements.camera.videoWidth;
  const height = elements.camera.videoHeight;
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  if (!message) return;
  const fontSize = Math.max(14, Math.round(width * 0.035));
  context.font = `600 ${fontSize}px system-ui, sans-serif`;
  const textWidth = context.measureText(message).width;
  const x = Math.round(width * 0.035);
  const y = Math.round(height * 0.09);
  context.fillStyle = "rgba(5, 12, 20, .76)";
  context.fillRect(x - 9, y - fontSize, textWidth + 18, fontSize + 18);
  context.fillStyle = color;
  context.fillText(message, x, y);
}

function playAlarmPulse() {
  if (!audioContext || audioContext.state !== "running") return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const startTime = audioContext.currentTime;
  const endTime = startTime + 0.38;
  const volume = (alarmActive ? episodeSettings : alertSettings).alarmVolume / 100;
  oscillator.type = "square";
  oscillator.frequency.value = 980;
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.02);
  gain.gain.setValueAtTime(volume, endTime - 0.08);
  gain.gain.exponentialRampToValueAtTime(0.0001, endTime);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(startTime);
  oscillator.stop(endTime);
}

function startAlarm() {
  if (alarmActive || alarmTimedOut) return;
  alarmActive = true;
  playAlarmPulse();
  alarmInterval = window.setInterval(playAlarmPulse, ALARM_PULSE_INTERVAL);
  alarmTimeout = window.setTimeout(() => {
    alarmTimedOut = true;
    stopAlarm();
    addActivity(`Alarm stopped at the ${episodeSettings.alarmLimitSeconds}-second limit.`);
  }, episodeSettings.alarmLimitSeconds * 1000);
  addActivity("Loud pulsed alarm started.");
}

function stopAlarm() {
  if (alarmInterval) window.clearInterval(alarmInterval);
  if (alarmTimeout) window.clearTimeout(alarmTimeout);
  alarmInterval = undefined;
  alarmTimeout = undefined;
  alarmActive = false;
}

async function testAlarmSound() {
  try {
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContext();
    }
    await audioContext.resume();
    playAlarmPulse();
    setStatus("Test beep played. Turn up your device volume if needed.", "success");
  } catch (error) {
    setStatus(`Could not play the test beep: ${error.message}`, "error");
  }
}

function captureSnapshot() {
  const video = elements.camera;
  if (!video.videoWidth || !video.videoHeight) return;
  const capture = document.createElement("canvas");
  capture.width = video.videoWidth;
  capture.height = video.videoHeight;
  const context = capture.getContext("2d");
  context.drawImage(video, 0, 0, capture.width, capture.height);
  context.drawImage(elements.overlay, 0, 0, capture.width, capture.height);
  capture.toBlob((blob) => {
    if (!blob) {
      addActivity("Could not create an alert snapshot.");
      return;
    }
    if (snapshotUrl) URL.revokeObjectURL(snapshotUrl);
    snapshotUrl = URL.createObjectURL(blob);
    elements.snapshot.href = snapshotUrl;
    elements.snapshot.hidden = false;
    addActivity("Alert snapshot ready to download.");
  }, "image/jpeg", 0.9);
}

function canRetryNotification(kind, targetEpisode) {
  const enabled = kind === "sms" ? episodeSettings.smsEnabled : episodeSettings.callEnabled;
  const requiredStage = kind === "sms" ? 2 : 3;
  const recovered =
    normalSince !== null &&
    performance.now() - normalSince >= episodeSettings.recoverySeconds * 1000;
  return (
    running &&
    episodeId === targetEpisode &&
    enabled &&
    alertStage >= requiredStage &&
    notificationAttempts[kind] < 1 + episodeSettings.retryLimit &&
    !recovered
  );
}

function scheduleNotificationRetry(kind, targetEpisode) {
  if (!canRetryNotification(kind, targetEpisode) || retryTimers[kind] !== null) return;
  const nextAttempt = notificationAttempts[kind] + 1;
  const maxAttempts = 1 + episodeSettings.retryLimit;
  addActivity(
    `${kind.toUpperCase()} retry ${nextAttempt}/${maxAttempts} scheduled in ${episodeSettings.retryDelaySeconds} seconds.`,
  );
  retryTimers[kind] = window.setTimeout(() => {
    retryTimers[kind] = null;
    if (canRetryNotification(kind, targetEpisode)) {
      void sendRemoteAlert(kind, targetEpisode);
    }
  }, episodeSettings.retryDelaySeconds * 1000);
}

async function sendRemoteAlert(kind, targetEpisode = episodeId) {
  const enabled = kind === "sms" ? episodeSettings.smsEnabled : episodeSettings.callEnabled;
  if (!enabled) {
    addActivity(`${kind.toUpperCase()} skipped: disabled in alert settings.`);
    return;
  }
  if (!phoneNumber) {
    addActivity(`${kind.toUpperCase()} skipped: no alert phone was entered.`);
    return;
  }
  if (!elements.accessCodeLabel.hidden && !elements.accessCode.value.trim()) {
    addActivity(`${kind.toUpperCase()} skipped: enter the site's remote alert access code.`);
    return;
  }
  if (targetEpisode !== episodeId || notificationAttempts[kind] >= 1 + episodeSettings.retryLimit) return;

  notificationAttempts[kind] += 1;
  const attempt = notificationAttempts[kind];
  const maxAttempts = 1 + episodeSettings.retryLimit;
  try {
    const headers = { "Content-Type": "application/json" };
    const accessCode = elements.accessCode.value.trim();
    if (accessCode) headers["X-Alert-Access-Code"] = accessCode;
    const response = await fetch("/api/alerts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind,
        name: userName,
        phone: phoneNumber,
        message: kind === "sms" ? episodeSettings.smsMessage : episodeSettings.callMessage,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Notification failed.");
    if (targetEpisode !== episodeId) return;
    addActivity(`${kind.toUpperCase()} ${attempt}/${maxAttempts} accepted by Twilio.`);
    scheduleNotificationRetry(kind, targetEpisode);
  } catch (error) {
    addActivity(`${kind.toUpperCase()} ${attempt}/${maxAttempts} failed: ${error.message}`);
  }
}

function updateDrowsinessState(drowsy, now) {
  if (drowsy) {
    normalSince = null;
    if (!drowsinessStartedAt) {
      drowsinessStartedAt = now;
      beginAlertEpisode(alertSettings);
    }
    if (!alarmActive) startAlarm();
    return;
  }

  if (normalSince === null) normalSince = now;
  if (now - normalSince >= episodeSettings.recoverySeconds * 1000) {
    stopAlarm();
    clearNotificationRetries();
    if (alertStage > 0) resetEpisode();
  }
}

function handleAlert(drowsy, now) {
  if (!drowsy || !drowsinessStartedAt) return;
  const elapsedSeconds = (now - drowsinessStartedAt) / 1000;

  if (alertStage === 0) {
    alertStage = 1;
    setAlert(1, "You may be getting drowsy. Stay alert.", "warning");
    addActivity("Stage 1: local pulsed alarm started.");
  }
  if (alertStage === 1 && elapsedSeconds >= episodeSettings.smsDelaySeconds) {
    alertStage = 2;
    setAlert(
      2,
      episodeSettings.smsEnabled
        ? "Drowsiness detected. SMS and snapshot stage."
        : "Drowsiness detected. SMS is disabled; snapshot saved.",
      "danger",
    );
    drawOverlay("Drowsiness detected!", "#ff777d");
    captureSnapshot();
    if (episodeSettings.smsEnabled) {
      void sendRemoteAlert("sms");
    } else {
      addActivity("SMS skipped: disabled in alert settings.");
    }
    addActivity("Stage 2: drowsiness alert detected.");
  }
  if (
    alertStage === 2 &&
    elapsedSeconds >= episodeSettings.smsDelaySeconds + episodeSettings.callDelaySeconds
  ) {
    alertStage = 3;
    setAlert(
      3,
      episodeSettings.callEnabled
        ? "Drowsiness continues. An alert call is being placed."
        : "Drowsiness continues. Voice calls are disabled.",
      "danger",
    );
    drawOverlay(
      episodeSettings.callEnabled ? "Alert: phone call" : "Drowsiness continues",
      "#ff777d",
    );
    if (episodeSettings.callEnabled) {
      void sendRemoteAlert("call");
      addActivity("Stage 3: voice-call alert started.");
    } else {
      addActivity("Voice call skipped: disabled in alert settings.");
    }
  }
}

function processFrame(now) {
  if (!running || elements.camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    if (running) animationFrame = requestAnimationFrame(processFrame);
    return;
  }
  if (now - lastProcessedAt < 1000 / 30) {
    animationFrame = requestAnimationFrame(processFrame);
    return;
  }
  lastProcessedAt = now;

  try {
    const timestamp = Math.max(Math.round(now), lastTimestamp + 1);
    lastTimestamp = timestamp;
    const result = faceLandmarker.detectForVideo(elements.camera, timestamp);
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks) {
      elements.faceStatus.textContent = "No face detected";
      elements.ear.textContent = "—";
      elements.mar.textContent = "—";
      elements.head.textContent = "—";
      drawOverlay("Move into the camera view", "#e7edf5");
    } else {
      const ear = (calculateEar(landmarks, leftEyeIndices) + calculateEar(landmarks, rightEyeIndices)) / 2;
      const mar = calculateMar(landmarks);
      const head = getHeadDirection(landmarks);
      elements.faceStatus.textContent = "Face detected";
      elements.ear.textContent = ear.toFixed(3);
      elements.mar.textContent = mar.toFixed(3);
      elements.head.textContent = head;

      earCounter = ear < EAR_THRESHOLD ? earCounter + 1 : 0;
      marCounter = mar > MAR_THRESHOLD ? marCounter + 1 : 0;
      const tilted = head !== "Centered";
      const drowsy =
        earCounter >= EAR_CONSEC_FRAMES ||
        marCounter >= MAR_CONSEC_FRAMES ||
        (ear < EAR_THRESHOLD && tilted);
      updateDrowsinessState(drowsy, now);
      handleAlert(drowsy, now);
      if (alertStage >= 3) {
        drawOverlay(
          episodeSettings.callEnabled ? "Alert: phone call" : "Drowsiness continues",
          "#ff777d",
        );
      } else if (alertStage === 2) {
        drawOverlay(
          episodeSettings.smsEnabled ? "Drowsiness detected!" : "SMS disabled; snapshot saved",
          "#ff777d",
        );
      } else if (alertStage === 1) {
        drawOverlay("You seem drowsy. Stay alert!", "#ffe188");
      } else if (marCounter >= MAR_CONSEC_FRAMES) {
        drawOverlay("Yawning detected", "#ffba68");
      } else {
        drawOverlay(`Head ${head.toLowerCase()}`, "#60e1c0");
      }
    }
    animationFrame = requestAnimationFrame(processFrame);
  } catch (error) {
    stopDetection();
    setStatus(`Detection stopped: ${error.message}`, "error");
    addActivity(`Detection error: ${error.message}`);
  }
}

async function createDetector() {
  if (faceLandmarker) return faceLandmarker;
  setStatus("Loading the face landmark model. This needs an internet connection…");
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  try {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "GPU" },
    });
  } catch {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, options);
  }
  return faceLandmarker;
}

async function startDetection() {
  userName = elements.name.value.trim();
  phoneNumber = elements.phone.value.trim();
  if (!userName) {
    setStatus("Enter your name before starting.", "error");
    elements.name.focus();
    return;
  }
  if (phoneNumber && !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    setStatus("Enter the phone number in international format, such as +14155550123.", "error");
    elements.phone.focus();
    return;
  }
  if (!phoneNumber) {
    addActivity("Remote SMS and calls are disabled until an alert phone is entered.");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Camera access is unavailable. Use localhost or a secure HTTPS website.", "error");
    return;
  }

  elements.start.disabled = true;
  setStatus("Preparing camera and detection model…");
  try {
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContext();
    }
    await audioContext.resume();
    await createDetector();
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
    elements.camera.srcObject = cameraStream;
    await elements.camera.play();
    running = true;
    earCounter = 0;
    marCounter = 0;
    alertStage = 0;
    normalSince = null;
    drowsinessStartedAt = 0;
    alarmActive = false;
    beginAlertEpisode(alertSettings);
    lastTimestamp = 0;
    lastProcessedAt = 0;
    elements.camera.parentElement.style.aspectRatio = `${elements.camera.videoWidth} / ${elements.camera.videoHeight}`;
    elements.snapshot.hidden = true;
    setAlert(0, "No alert. Detection is standing by.", "");
    elements.placeholder.hidden = true;
    elements.start.disabled = true;
    elements.stop.disabled = false;
    setCameraState(true);
    elements.faceStatus.textContent = "Looking for a face…";
    setStatus("Detection is running. Keep the camera steady and stay in view.", "success");
    addActivity("Camera detection started.");
    animationFrame = requestAnimationFrame(processFrame);
  } catch (error) {
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = undefined;
    elements.camera.srcObject = null;
    elements.start.disabled = false;
    setCameraState(false);
    setStatus(`Could not start detection: ${error.message}`, "error");
    addActivity(`Start failed: ${error.message}`);
  }
}

function stopDetection() {
  running = false;
  stopAlarm();
  beginAlertEpisode();
  normalSince = null;
  drowsinessStartedAt = 0;
  if (animationFrame) cancelAnimationFrame(animationFrame);
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = undefined;
  elements.camera.srcObject = null;
  elements.overlay.getContext("2d").clearRect(0, 0, elements.overlay.width, elements.overlay.height);
  elements.placeholder.hidden = false;
  elements.start.disabled = false;
  elements.stop.disabled = true;
  elements.faceStatus.textContent = "Detection stopped";
  setCameraState(false);
  setStatus("Detection stopped. Start again whenever you are ready.");
  if (audioContext) {
    void audioContext.close();
    audioContext = undefined;
  }
  if (faceLandmarker) {
    faceLandmarker.close();
    faceLandmarker = undefined;
  }
  addActivity("Camera detection stopped.");
}

async function checkTwilioStatus() {
  try {
    const response = await fetch("/api/status");
    const result = await response.json();
    elements.accessCodeLabel.hidden = !result.requiresAccessCode;
    if (result.twilioConfigured) {
      elements.twilioStatus.textContent = result.requiresAccessCode
        ? "Remote alerts are configured for approved numbers; enter the site's access code."
        : "SMS and call alerts are configured on this server.";
      elements.twilioStatus.classList.add("configured");
    } else if (result.requiresAccessCode) {
      elements.twilioStatus.textContent = "Remote alert server setup is incomplete.";
    } else {
      elements.twilioStatus.textContent = "No Twilio setup: camera detection and local sound still work.";
    }
  } catch {
    elements.twilioStatus.textContent = "Remote alerts need the local web server and Twilio setup.";
  }
}

elements.start.addEventListener("click", () => void startDetection());
elements.stop.addEventListener("click", stopDetection);
elements.testSound.addEventListener("click", () => void testAlarmSound());
elements.alarmVolume.addEventListener("input", () => {
  elements.alarmVolumeValue.textContent = `${elements.alarmVolume.value}%`;
});
elements.saveSettings.addEventListener("click", saveAlertSettings);
window.addEventListener("beforeunload", () => {
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  if (faceLandmarker) faceLandmarker.close();
  if (snapshotUrl) URL.revokeObjectURL(snapshotUrl);
});

loadAlertSettings();
void checkTwilioStatus();
