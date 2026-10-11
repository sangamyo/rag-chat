# Hand Gesture Control System

**▶ Live demo (browser version):** https://sangamyo.github.io/control_with_hand_gesture/

Control your computer with hand gestures in front of a webcam, plus a small voice assistant. Built with Python, OpenCV and MediaPipe hand tracking.

## What it does

| Mode | How | Script |
|------|-----|--------|
| **Mouse control** | Raise your **index** finger (middle finger down) to move the cursor; lower the index and raise the **middle** finger to click. Your hand is tracked inside a blue frame that maps to the whole screen, with smoothing to cut jitter. | `Working_Func/Mouse_Control.py` |
| **Volume control** | The distance between your **thumb and index** fingertips (50–270 px) sets the system volume from 0 to 100% (macOS, via `osascript`). | `Working_Func/Volume_Control.py` |
| **Voice assistant** | Speech recognition for commands such as *"Wikipedia …"*, *"the time"*, *"open YouTube / Google / Stack Overflow"*, *"play music"*, with spoken replies. | `Working_Func/Jarvis.py` |

`Main.py` is a small Tkinter launcher with a button for each mode. Press `Esc` in a camera window to close it.

## Run the desktop app

```sh
pip install opencv-python mediapipe numpy pyautogui pyttsx3 SpeechRecognition pyaudio wikipedia
python Main.py
```

You need a webcam (and a microphone for the voice assistant). Volume control and some voice commands use macOS commands.

## Browser version

`web/index.html` is a JavaScript port that runs the same MediaPipe hand model in the browser and applies the same gesture rules (frame mapping, smoothing, pinch range). A webpage can't move your real mouse or change system volume, so in the demo the cursor clicks folders on a virtual desktop and the pinch controls the volume of a test tone. The voice assistant uses the browser's Web Speech API. Video stays on your device.

Every push to `main` deploys `web/` to GitHub Pages (`.github/workflows/deploy-web.yml`).

## References

- [MediaPipe Hands](https://github.com/google/mediapipe/blob/master/docs/solutions/hands.md) and [Hand Landmarker for Web](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js)
- [AI Virtual Mouse (tutorial)](https://www.youtube.com/watch?v=8gPONnGIPgw)
- [Mouse and keyboard automation using Python (GeeksforGeeks)](https://www.geeksforgeeks.org/mouse-keyboard-automation-using-python/)
