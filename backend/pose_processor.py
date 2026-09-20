"""
StanceAI — MediaPipe Pose Processor
======================================
Wraps the MediaPipe Pose solution into a class that:
  1. Initialises the model once at app startup
  2. Accepts raw OpenCV BGR frames
  3. Returns normalised landmark dicts + an annotated BGR frame

MediaPipe Pose produces 33 skeletal landmarks (world & image coordinates).
We use normalised image coordinates (x, y ∈ [0, 1]) for angle calculations
since we're comparing structure, not absolute spatial scale.

IMPORTANT — Windows App Control workaround:
  mediapipe/__init__.py eagerly imports mediapipe.python.solutions which
  transitively imports matplotlib (drawing_styles → drawing_utils → plt).
  On systems where Application Control blocks matplotlib's native DLLs,
  this causes an ImportError at startup.

  Fix: We monkey-patch sys.modules to inject a stub for
  mediapipe.python.solutions.drawing_styles BEFORE importing mediapipe,
  so the package __init__ succeeds without ever loading matplotlib.
  The actual skeleton drawing uses plain OpenCV instead.
"""

from __future__ import annotations

import logging
import sys
import types
from typing import Any, Optional

import cv2
import numpy as np

from models import LandmarkPoint

# ── Matplotlib / drawing_styles stub ────────────────────────────────────────
# Inject empty stub modules into sys.modules before mediapipe is imported.
# This prevents mediapipe/__init__.py from loading matplotlib which may be
# blocked by Windows Application Control policy (DLL load failure).

def _stub_module(name: str) -> types.ModuleType:
    mod = types.ModuleType(name)
    sys.modules[name] = mod
    return mod

if "matplotlib" not in sys.modules:
    _stub_module("matplotlib")
    _stub_module("matplotlib.pyplot")
    _stub_module("matplotlib.patches")
    _stub_module("matplotlib.colors")

# Stub the drawing_utils DrawingSpec that drawing_styles imports
_du_stub = _stub_module("mediapipe.python.solutions.drawing_utils")
class _DrawingSpec:  # noqa: E302
    def __init__(self, *a, **kw): pass
_du_stub.DrawingSpec = _DrawingSpec  # type: ignore

_ds_stub = _stub_module("mediapipe.python.solutions.drawing_styles")
_ds_stub.get_default_pose_landmarks_style = lambda: None  # type: ignore

# ── Now safe to import mediapipe ─────────────────────────────────────────────
import mediapipe.python.solutions.pose as mp_pose  # noqa: E402

logger = logging.getLogger("stanceai.pose")


# MediaPipe Pose connection pairs for manual skeleton drawing
# (same as mp.solutions.pose.POSE_CONNECTIONS but defined inline
#  to avoid importing the full solutions package with matplotlib)
_POSE_CONNECTIONS = [
    (0,1),(1,2),(2,3),(3,7),(0,4),(4,5),(5,6),(6,8),(9,10),
    (11,12),(11,13),(13,15),(15,17),(15,19),(15,21),(17,19),
    (12,14),(14,16),(16,18),(16,20),(16,22),(18,20),
    (11,23),(12,24),(23,24),
    (23,25),(25,27),(27,29),(29,31),(27,31),
    (24,26),(26,28),(28,30),(30,32),(28,32),
]


class PoseProcessor:
    """
    Singleton-style MediaPipe Pose wrapper.

    Usage
    -----
    processor = PoseProcessor()
    result = processor.process_frame(bgr_frame)
    # result["landmarks"] → list[LandmarkPoint]
    # result["annotated_frame"] → np.ndarray (BGR)
    """

    def __init__(
        self,
        min_detection_confidence: float = 0.5,
        min_tracking_confidence: float = 0.5,
        model_complexity: int = 1,
        smooth_landmarks: bool = True,
    ):
        """
        Initialise MediaPipe Pose.

        Parameters
        ----------
        min_detection_confidence : float
            Minimum confidence for pose detection to be considered successful.
        min_tracking_confidence : float
            Minimum confidence for pose tracking to be considered successful.
        model_complexity : int
            0 = lite (fastest), 1 = full (default), 2 = heavy (most accurate)
        smooth_landmarks : bool
            Whether to apply temporal smoothing to reduce landmark jitter.
        """
        self._pose = mp_pose.Pose(
            static_image_mode=False,
            model_complexity=model_complexity,
            smooth_landmarks=smooth_landmarks,
            min_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence,
        )
        self._ready = True
        logger.info(
            f"PoseProcessor initialised — model_complexity={model_complexity}, "
            f"detection_conf={min_detection_confidence}, "
            f"tracking_conf={min_tracking_confidence}"
        )

    def is_ready(self) -> bool:
        """Return True if the MediaPipe model is loaded and ready."""
        return self._ready

    def process_frame(self, bgr_frame: np.ndarray) -> dict[str, Any]:
        """
        Run pose estimation on a single BGR OpenCV frame.

        Parameters
        ----------
        bgr_frame : np.ndarray
            Raw BGR image from cv2 (e.g., from VideoCapture or decoded upload).

        Returns
        -------
        dict with keys:
            landmarks      : list[LandmarkPoint]  — Empty if no pose detected
            annotated_frame: np.ndarray            — BGR frame with skeleton drawn
            pose_detected  : bool
            raw_results    : mediapipe results object (for downstream use)
        """
        if bgr_frame is None or bgr_frame.size == 0:
            logger.warning("process_frame received an empty or None frame.")
            return {
                "landmarks": [],
                "annotated_frame": np.zeros((480, 640, 3), dtype=np.uint8),
                "pose_detected": False,
                "raw_results": None,
            }

        # MediaPipe requires RGB
        rgb_frame = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
        rgb_frame.flags.writeable = False

        # Run inference
        results = self._pose.process(rgb_frame)

        # Make frame writeable again for drawing
        rgb_frame.flags.writeable = True
        annotated_frame = cv2.cvtColor(rgb_frame, cv2.COLOR_RGB2BGR)

        if not results.pose_landmarks:
            logger.debug("No pose landmarks detected in frame.")
            return {
                "landmarks": [],
                "annotated_frame": annotated_frame,
                "pose_detected": False,
                "raw_results": results,
            }

        # Draw skeleton overlay on annotated frame
        self._draw_landmarks(annotated_frame, results)

        # Extract normalised landmarks
        landmarks = self._extract_landmarks(results)

        return {
            "landmarks": landmarks,
            "annotated_frame": annotated_frame,
            "pose_detected": True,
            "raw_results": results,
        }

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _draw_landmarks(self, frame: np.ndarray, results: Any) -> None:
        """
        Draw the pose skeleton using plain OpenCV primitives.
        Avoids mediapipe.drawing_styles (which imports matplotlib).
        The frontend canvas renders its own colour-coded overlay;
        this annotated frame is useful for the REST /analyze endpoint.
        """
        h, w = frame.shape[:2]
        lms = results.pose_landmarks.landmark

        # Draw bones    
        for (a, b) in _POSE_CONNECTIONS:
            if lms[a].visibility < 0.3 or lms[b].visibility < 0.3:
                continue
            pt_a = (int(lms[a].x * w), int(lms[a].y * h))
            pt_b = (int(lms[b].x * w), int(lms[b].y * h))
            cv2.line(frame, pt_a, pt_b, (61, 142, 240), 2, cv2.LINE_AA)

        # Draw joints
        for lm in lms:
            if lm.visibility < 0.3:
                continue
            cx, cy = int(lm.x * w), int(lm.y * h)
            cv2.circle(frame, (cx, cy), 5, (255, 255, 255), -1, cv2.LINE_AA)
            cv2.circle(frame, (cx, cy), 5, (61, 142, 240),  2, cv2.LINE_AA)

    def _extract_landmarks(self, results: Any) -> list[LandmarkPoint]:
        """
        Convert MediaPipe landmark objects to Pydantic LandmarkPoint models.

        Returns a list of exactly 33 items (one per MediaPipe Pose landmark).
        """
        landmarks: list[LandmarkPoint] = []
        for idx, lm in enumerate(results.pose_landmarks.landmark):
            landmarks.append(LandmarkPoint(
                index=idx,
                x=float(lm.x),
                y=float(lm.y),
                z=float(lm.z),
                visibility=float(lm.visibility),
            ))
        return landmarks

    def close(self) -> None:
        """Release MediaPipe resources."""
        self._pose.close()
        self._ready = False
        logger.info("PoseProcessor closed and MediaPipe resources released.")
