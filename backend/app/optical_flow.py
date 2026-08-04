import cv2
import numpy as np

# Global, not per-session — /analyze-frame is stateless per request and
# there's currently no session key on the video feed. Fine for this app's
# one-operator-at-a-time model; would need a session id if concurrent
# live feeds from different users are ever supported.
_prev_gray = None


def estimate_motion_from_frame(frame):
    """Dense optical flow between this frame and the previous one —
    a genuinely video-derived signal for which way the camera is
    panning/moving, not a simulated value. This is relative motion, not
    an absolute compass heading (no magnetometer here to anchor it to
    true north), and it only means anything within a single continuous
    clip — call reset_motion_tracking() whenever the video source
    changes.
    """
    global _prev_gray

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray_small = cv2.resize(gray, (160, 90))

    if _prev_gray is None:
        _prev_gray = gray_small
        return None

    flow = cv2.calcOpticalFlowFarneback(
        _prev_gray, gray_small, None,
        pyr_scale=0.5, levels=2, winsize=15,
        iterations=2, poly_n=5, poly_sigma=1.2, flags=0,
    )
    _prev_gray = gray_small

    mean_dx = float(np.mean(flow[..., 0]))
    mean_dy = float(np.mean(flow[..., 1]))
    magnitude = round(float(np.hypot(mean_dx, mean_dy)), 3)

    if magnitude < 0.05:
        return {"heading_delta_deg": 0.0, "magnitude": magnitude}

    heading_delta_deg = round(float(np.degrees(np.arctan2(mean_dy, mean_dx))), 1)
    return {"heading_delta_deg": heading_delta_deg, "magnitude": magnitude}


def reset_motion_tracking():
    global _prev_gray
    _prev_gray = None