import tkinter as tk
from tkinter import messagebox
from threading import Thread
import cv2
from scipy.spatial import distance
import pygame
from PIL import Image, ImageTk
import mediapipe as mp
import os
import time
from dotenv import load_dotenv

try:
    from twilio.rest import Client
    from twilio.twiml.voice_response import VoiceResponse
except ImportError:
    Client = None
    VoiceResponse = None


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ALERT_SOUND_PATH = os.path.join(BASE_DIR, "audio", "alert.wav")
CAPTURE_FOLDER = os.path.join(BASE_DIR, "captures")
BACKGROUND_IMAGE_PATH = os.path.join(BASE_DIR, "Drowsy.jpeg")
load_dotenv(os.path.join(BASE_DIR, ".env"))

EAR_THRESHOLD = 0.25
MAR_THRESHOLD = 0.6
EAR_CONSEC_FRAMES = 32
MAR_CONSEC_FRAMES = 15
ALERT_COOLDOWN = 10
ALERT_TEXT = "Drowsiness Detected!"

pygame.mixer.init()
alarm_sound = pygame.mixer.Sound(ALERT_SOUND_PATH)
os.makedirs(CAPTURE_FOLDER, exist_ok=True)
face_mesh = mp.solutions.face_mesh.FaceMesh(
    max_num_faces=1,
    refine_landmarks=True,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
)


def get_twilio_settings():
    settings = (
        os.getenv("TWILIO_ACCOUNT_SID", "").strip(),
        os.getenv("TWILIO_AUTH_TOKEN", "").strip(),
        os.getenv("TWILIO_PHONE_NUMBER", "").strip(),
    )
    if any(not value or value.lower().startswith("your_") for value in settings):
        return None
    return settings


def calculate_ear(eye):
    A = distance.euclidean(eye[1], eye[5])
    B = distance.euclidean(eye[2], eye[4])
    C = distance.euclidean(eye[0], eye[3])
    return (A + B) / (2.0 * C)

def calculate_mar(mouth):
    horizontal = distance.euclidean(mouth[0], mouth[1])
    if horizontal == 0:
        return 0
    vertical_a = distance.euclidean(mouth[2], mouth[3])
    vertical_b = distance.euclidean(mouth[4], mouth[5])
    vertical_c = distance.euclidean(mouth[6], mouth[7])
    return (vertical_a + vertical_b + vertical_c) / (3.0 * horizontal)

def get_head_tilt_direction(nose_point, chin_point):
    dx = chin_point[0] - nose_point[0]
    if dx > 15:
        return "Head Tilt Right"
    elif dx < -15:
        return "Head Tilt Left"
    else:
        return "Head Centered"

def play_alarm():
    try:
        pygame.mixer.Sound.play(alarm_sound)
    except Exception as e:
        print(f"Error playing alarm: {e}")

def send_sms_notification(sender_name, phone_number):
    try:
        if Client is None:
            print("Twilio SMS skipped: the twilio package is not installed.")
            return

        settings = get_twilio_settings()
        if settings is None or not phone_number:
            print("Twilio SMS skipped: Twilio credentials or recipient number are missing.")
            return

        account_sid, auth_token, twilio_phone = settings
        client = Client(account_sid, auth_token)
        message = client.messages.create(
            body=f"Alert: {sender_name} appears to be drowsy.",
            from_=twilio_phone,
            to=phone_number
        )
        print(f"SMS sent to {phone_number}. SID: {message.sid}")
    except Exception as e:
        print(f"Failed to send SMS: {e}")


def make_phone_call(sender_name, phone_number):
    try:
        if Client is None or VoiceResponse is None:
            print("Twilio call skipped: the twilio package is not installed.")
            return

        settings = get_twilio_settings()
        if settings is None or not phone_number:
            print("Twilio call skipped: Twilio credentials or recipient number are missing.")
            return

        account_sid, auth_token, twilio_phone = settings
        response = VoiceResponse()
        response.say(
            f"Drowsiness alert. {sender_name} appears to be drowsy. Please check immediately.",
            voice="alice",
        )
        client = Client(account_sid, auth_token)
        call = client.calls.create(
            twiml=str(response),
            from_=twilio_phone,
            to=phone_number,
        )
        print(f"Phone call started to {phone_number}. SID: {call.sid}")
    except Exception as e:
        print(f"Failed to make phone call: {e}")


class DrowsinessApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Drowsiness Detection System")
        self.root.geometry("600x500")
        self.root.resizable(False, False)

        try:
            bg_image = Image.open(BACKGROUND_IMAGE_PATH).resize((600, 500))
            self.bg_photo = ImageTk.PhotoImage(bg_image)
            self.bg_label = tk.Label(self.root, image=self.bg_photo)
            self.bg_label.place(x=0, y=0, relwidth=1, relheight=1)
        except:
            self.root.configure(bg='white')

        tk.Label(root, text="Drowsiness Detection System", font=("Segoe UI", 18, "bold"), bg="white").pack(pady=20)
        tk.Label(root, text="Your Name:", font=("Segoe UI", 12), bg="white").place(x=100, y=100)
        self.user_name_entry = tk.Entry(root, font=("Segoe UI", 12))
        self.user_name_entry.place(x=250, y=100)

        tk.Label(root, text="Phone (+CountryCode):", font=("Segoe UI", 12), bg="white").place(x=60, y=150)
        self.phone_number_entry = tk.Entry(root, font=("Segoe UI", 12))
        self.phone_number_entry.place(x=250, y=150)

        self.start_button = tk.Button(root, text="Start Detection", font=("Segoe UI", 12), command=self.start_detection)
        self.start_button.place(x=100, y=220)
        self.stop_button = tk.Button(root, text="Stop Detection", font=("Segoe UI", 12), command=self.stop_detection, state=tk.DISABLED)
        self.stop_button.place(x=250, y=220)
        self.exit_button = tk.Button(root, text="Exit", font=("Segoe UI", 12), command=root.quit)
        self.exit_button.place(x=400, y=220)

        self.running = False
        self.detection_thread = None

    def start_detection(self):
        user_name = self.user_name_entry.get()
        phone_number = self.phone_number_entry.get()

        if not user_name or not phone_number:
            messagebox.showerror("Error", "Please enter both Name and Phone.")
            return

        if get_twilio_settings() is None:
            messagebox.showwarning(
                "Twilio is not configured",
                "Beep alerts will work, but SMS and calls are disabled. "
                "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and "
                "TWILIO_PHONE_NUMBER in the project's .env file.",
            )

        self.running = True
        self.start_button.config(state=tk.DISABLED)
        self.stop_button.config(state=tk.NORMAL)
        self.detection_thread = Thread(target=self.detect_drowsiness, args=(user_name, phone_number))
        self.detection_thread.start()

    def stop_detection(self):
        self.running = False
        self.start_button.config(state=tk.NORMAL)
        self.stop_button.config(state=tk.DISABLED)

    def detect_drowsiness(self, user_name, phone_number):
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            messagebox.showerror("Camera Error", "Could not open the webcam.")
            self.stop_detection()
            return

        ear_counter, mar_counter, last_alert_time, drowsy_stage_counter = 0, 0, 0,0
        sms_sent = False
        call_started = False
        left_eye_indices = [33, 160, 158, 133, 153, 144]
        right_eye_indices = [263, 387, 385, 362, 380, 373]
        mouth_indices = [61, 291, 39, 181, 0, 17, 269, 405]

        while self.running:
            ret, frame = cap.read()
            if not ret:
                break

            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = face_mesh.process(rgb_frame)

            if results.multi_face_landmarks:
                face_landmarks = results.multi_face_landmarks[0].landmark
                height, width = frame.shape[:2]
                left_eye = [(int(face_landmarks[i].x * width), int(face_landmarks[i].y * height)) for i in left_eye_indices]
                right_eye = [(int(face_landmarks[i].x * width), int(face_landmarks[i].y * height)) for i in right_eye_indices]
                mouth = [(int(face_landmarks[i].x * width), int(face_landmarks[i].y * height)) for i in mouth_indices]
                nose_point = (
                    int(face_landmarks[1].x * width),
                    int(face_landmarks[1].y * height),
                )
                chin_point = (
                    int(face_landmarks[152].x * width),
                    int(face_landmarks[152].y * height),
                )


                ear = (calculate_ear(left_eye) + calculate_ear(right_eye)) / 2.0
                mar = calculate_mar(mouth)
                head_direction = get_head_tilt_direction(nose_point, chin_point)

                cv2.putText(frame, head_direction, (10, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2)

                head_tilted = head_direction in ["Head Tilt Left", "Head Tilt Right"]

                if mar_counter >= MAR_CONSEC_FRAMES:
                    cv2.putText(frame, "Yawning Detected", (10, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 140, 255), 2)

                ear_counter = ear_counter + 1 if ear < EAR_THRESHOLD else 0
                mar_counter = mar_counter + 1 if mar > MAR_THRESHOLD else 0

                # Combine EAR and Head Tilt logic
                drowsy_detected = (ear_counter >= EAR_CONSEC_FRAMES or 
                                   mar_counter >= MAR_CONSEC_FRAMES or 
                                   (ear < EAR_THRESHOLD and head_tilted))

                if ear < EAR_THRESHOLD and head_tilted:
                    cv2.putText(frame, "Tilt + Eyes Closed = Drowsy", (10, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 100, 255), 2)

                current_time = time.time()

                if drowsy_detected and (current_time - last_alert_time > ALERT_COOLDOWN):
                    last_alert_time = current_time
                    drowsy_stage_counter += 1

                    if drowsy_stage_counter == 1:
                        cv2.putText(frame, "You seem drowsy. Stay alert!", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
                        play_alarm()
                        print("Stage 1 alert: Beep sound")
                    elif drowsy_stage_counter == 2:
                        cv2.putText(frame, ALERT_TEXT, (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
                        timestamp = time.strftime("%Y%m%d-%H%M%S")
                        image_path = os.path.join(CAPTURE_FOLDER, f"drowsy_{timestamp}.jpg")
                        cv2.imwrite(image_path, frame)
                        if not sms_sent:
                            sms_sent = True
                            print("Stage 2 alert: Sending SMS")
                            Thread(target=send_sms_notification, args=(user_name, phone_number), daemon=True).start()
                    elif drowsy_stage_counter >= 3:
                        cv2.putText(frame, "Alert: SMS and phone call", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
                        if not call_started:
                            call_started = True
                            print("Stage 3 alert: Starting phone call")
                            Thread(target=make_phone_call, args=(user_name, phone_number), daemon=True).start()

                if not drowsy_detected and (current_time - last_alert_time > 2 * ALERT_COOLDOWN):
                    drowsy_stage_counter = 0
                    sms_sent = False
                    call_started = False

            cv2.imshow("Drowsiness Detection", frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

        cap.release()
        cv2.destroyAllWindows()

# ==== Run App ====
if __name__ == "__main__":
    root = tk.Tk()
    app = DrowsinessApp(root)
    root.mainloop()
