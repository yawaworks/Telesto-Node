"""Run YOLO inference directly against a video file or webcam for local testing.

Usage:
    python -m app.local_inference rov_feed.mp4
"""
import sys

import cv2

from app.inference import clahe_correct, get_model


def run_inference(source=0, conf_threshold: float = 0.35):
    model = get_model()
    cap = cv2.VideoCapture(source)
    while cap.isOpened():
        ok, frame = cap.read()
        if not ok:
            break

        frame = clahe_correct(frame)
        results = model.predict(frame, conf=conf_threshold, verbose=False)[0]

        for box in results.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            label = model.names[int(box.cls[0])]
            score = float(box.conf[0])
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 200), 2)
            cv2.putText(
                frame,
                f"{label} {score:.2f}",
                (x1, y1 - 8),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (0, 255, 200),
                1,
            )

        cv2.imshow("Telesto Node - Live Inference", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else 0
    run_inference(source=src)
