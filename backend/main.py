"""
StanceAI — FastAPI Application Entry Point
==========================================
Provides REST endpoints and a WebSocket stream for real-time
biomechanical pose analysis of cricket batting footage.

Endpoints:
  GET  /health           — Server health check
  POST /analyze          — Single frame analysis (multipart image upload)
  POST /session/start    — Start a new analysis session
  POST /session/{id}/end — End a session and compute final score
  WS   /ws/stream        — Real-time WebSocket streaming endpoint
"""

import asyncio
import base64
import json
import logging
from contextlib import asynccontextmanager
from typing import Optional

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from biomechanics import calculate_joint_angle, classify_angle_quality, MEDIAPIPE_CONNECTIONS
from models import (
    HealthResponse,
    AnalyzeRequest,
    AnalyzeResponse,
    SessionStartRequest,
    SessionStartResponse,
    LandmarkPoint,
    JointAngleResult,
)
from pose_processor import PoseProcessor

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
logger = logging.getLogger("stanceai")

# ---------------------------------------------------------------------------
# Application lifecycle — initialize MediaPipe once at startup
# ---------------------------------------------------------------------------
pose_processor: Optional[PoseProcessor] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pose_processor
    logger.info("🏏 StanceAI starting up — initialising MediaPipe Pose...")
    pose_processor = PoseProcessor()
    logger.info("✅ MediaPipe Pose initialised successfully.")
    yield
    logger.info("🛑 StanceAI shutting down — releasing MediaPipe resources.")
    if pose_processor:
        pose_processor.close()


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------
app = FastAPI(
    title="StanceAI API",
    description=(
        "Biomechanical Cricket Analyzer — real-time skeletal pose estimation, "
        "joint angle calculation, and benchmark comparison for cricket batters."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow React dev server (localhost:5173) and any future domain
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",   # Vite dev server
        "http://localhost:3000",   # fallback CRA port
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------
class ConnectionManager:
    """Manages active WebSocket client connections."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket client connected. Total: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)
        logger.info(f"WebSocket client disconnected. Total: {len(self.active_connections)}")

    async def send_json(self, websocket: WebSocket, data: dict):
        await websocket.send_json(data)


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# Utility: Decode uploaded image bytes → OpenCV BGR frame
# ---------------------------------------------------------------------------
def decode_image(image_bytes: bytes) -> np.ndarray:
    """Decode raw bytes (JPEG/PNG) into an OpenCV BGR numpy array."""
    nparr = np.frombuffer(image_bytes, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Could not decode image. Ensure the upload is a valid JPEG or PNG.")
    return frame


def encode_frame_to_base64(frame: np.ndarray) -> str:
    """Encode an OpenCV BGR frame to a base64 JPEG string for JSON transport."""
    _, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return base64.b64encode(buffer).decode("utf-8")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse, tags=["System"])
async def health_check():
    """
    Health check endpoint.
    Returns server status, API version, and MediaPipe readiness.
    """
    return HealthResponse(
        status="ok",
        version="0.1.0",
        service="StanceAI Biomechanical Analyzer",
        mediapipe_ready=pose_processor is not None and pose_processor.is_ready(),
    )


@app.post("/analyze", response_model=AnalyzeResponse, tags=["Analysis"])
async def analyze_frame(
    file: UploadFile = File(..., description="Single image frame (JPEG or PNG)"),
    shot_type: str = Form(default="COVER_DRIVE", description="Cricket shot type for benchmark lookup"),
    session_id: Optional[int] = Form(default=None, description="Optional session ID to log results"),
):
    """
    Analyze a single image frame.

    Accepts a multipart image upload, runs MediaPipe Pose estimation,
    calculates joint angles, compares against benchmarks, and returns
    annotated landmark data with quality classification.
    """
    if pose_processor is None:
        raise HTTPException(status_code=503, detail="Pose processor not yet initialised.")

    try:
        image_bytes = await file.read()
        frame = decode_image(image_bytes)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Run pose estimation
    result = pose_processor.process_frame(frame)

    if not result["landmarks"]:
        return AnalyzeResponse(
            success=False,
            message="No human pose detected in the provided frame.",
            landmarks=[],
            joint_angles=[],
            annotated_frame_b64=None,
        )

    # Calculate key joint angles
    landmarks = result["landmarks"]
    joint_angles = _compute_joint_angles(landmarks, shot_type)

    # Encode annotated frame
    annotated_b64 = encode_frame_to_base64(result["annotated_frame"])

    return AnalyzeResponse(
        success=True,
        message="Pose detected and analyzed successfully.",
        landmarks=landmarks,
        joint_angles=joint_angles,
        annotated_frame_b64=annotated_b64,
        shot_type=shot_type,
        session_id=session_id,
    )


@app.websocket("/ws/stream")
async def websocket_stream(websocket: WebSocket):
    """
    WebSocket endpoint for real-time pose streaming.

    The client sends base64-encoded JPEG frames as JSON:
      { "frame": "<base64_jpeg>", "shot_type": "COVER_DRIVE" }

    The server responds with:
      { "landmarks": [...], "joint_angles": [...], "annotated_frame": "<base64_jpeg>" }
    """
    await manager.connect(websocket)
    logger.info("WebSocket stream session started.")
    try:
        while True:
            # Receive frame payload from client
            raw_data = await websocket.receive_text()
            payload = json.loads(raw_data)

            frame_b64: str = payload.get("frame", "")
            shot_type: str = payload.get("shot_type", "COVER_DRIVE")

            if not frame_b64:
                await manager.send_json(websocket, {"error": "Empty frame received."})
                continue

            try:
                frame_bytes = base64.b64decode(frame_b64)
                frame = decode_image(frame_bytes)
            except Exception as e:
                await manager.send_json(websocket, {"error": f"Frame decode error: {str(e)}"})
                continue

            # Process
            result = pose_processor.process_frame(frame)

            if not result["landmarks"]:
                await manager.send_json(websocket, {
                    "success": False,
                    "message": "No pose detected.",
                })
                continue

            joint_angles = _compute_joint_angles(result["landmarks"], shot_type)
            annotated_b64 = encode_frame_to_base64(result["annotated_frame"])

            await manager.send_json(websocket, {
                "success": True,
                "landmarks": [lm.model_dump() for lm in result["landmarks"]],
                "joint_angles": [ja.model_dump() for ja in joint_angles],
                "annotated_frame": annotated_b64,
                "shot_type": shot_type,
            })

    except WebSocketDisconnect:
        manager.disconnect(websocket)
        logger.info("WebSocket client disconnected cleanly.")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# Internal: Joint Angle Computation
# ---------------------------------------------------------------------------

# Landmark index mapping (MediaPipe Pose — 33 keypoints)
LANDMARK_INDEX = {
    "NOSE": 0, "LEFT_EYE_INNER": 1, "LEFT_EYE": 2, "LEFT_EYE_OUTER": 3,
    "RIGHT_EYE_INNER": 4, "RIGHT_EYE": 5, "RIGHT_EYE_OUTER": 6,
    "LEFT_EAR": 7, "RIGHT_EAR": 8, "MOUTH_LEFT": 9, "MOUTH_RIGHT": 10,
    "LEFT_SHOULDER": 11, "RIGHT_SHOULDER": 12,
    "LEFT_ELBOW": 13, "RIGHT_ELBOW": 14,
    "LEFT_WRIST": 15, "RIGHT_WRIST": 16,
    "LEFT_PINKY": 17, "RIGHT_PINKY": 18,
    "LEFT_INDEX": 19, "RIGHT_INDEX": 20,
    "LEFT_THUMB": 21, "RIGHT_THUMB": 22,
    "LEFT_HIP": 23, "RIGHT_HIP": 24,
    "LEFT_KNEE": 25, "RIGHT_KNEE": 26,
    "LEFT_ANKLE": 27, "RIGHT_ANKLE": 28,
    "LEFT_HEEL": 29, "RIGHT_HEEL": 30,
    "LEFT_FOOT_INDEX": 31, "RIGHT_FOOT_INDEX": 32,
}

# Joint definitions: (joint_name, landmark_A, vertex_B, landmark_C)
# These are the joints we compute angles for — extend as needed
JOINT_DEFINITIONS = [
    ("FRONT_ELBOW",   "LEFT_SHOULDER",  "LEFT_ELBOW",  "LEFT_WRIST"),
    ("BACK_ELBOW",    "RIGHT_SHOULDER", "RIGHT_ELBOW", "RIGHT_WRIST"),
    ("FRONT_KNEE",    "LEFT_HIP",       "LEFT_KNEE",   "LEFT_ANKLE"),
    ("BACK_KNEE",     "RIGHT_HIP",      "RIGHT_KNEE",  "RIGHT_ANKLE"),
    ("FRONT_HIP",     "LEFT_SHOULDER",  "LEFT_HIP",    "LEFT_KNEE"),
    ("BACK_HIP",      "RIGHT_SHOULDER", "RIGHT_HIP",   "RIGHT_KNEE"),
    ("LEFT_SHOULDER", "LEFT_ELBOW",     "LEFT_SHOULDER", "LEFT_HIP"),
    ("RIGHT_SHOULDER","RIGHT_ELBOW",    "RIGHT_SHOULDER","RIGHT_HIP"),
]

# Shot-type → benchmark angle ranges (degrees) — mirrors the Oracle seed data
# In production these would be fetched from the DB via database.py
INLINE_BENCHMARKS = {
    "COVER_DRIVE": {
        "FRONT_ELBOW": (100.0, 140.0, 15.0, 30.0),
        "FRONT_KNEE":  (130.0, 165.0, 10.0, 25.0),
    },
    "PULL_SHOT": {
        "BACK_ELBOW": (85.0, 120.0, 15.0, 30.0),
    },
    "FORWARD_DEFENSE": {
        "FRONT_ELBOW": (60.0, 100.0, 10.0, 20.0),
    },
}


def _get_landmark_coords(landmarks: list[LandmarkPoint], name: str) -> Optional[tuple[float, float]]:
    """Look up x, y coords for a named landmark from the list."""
    idx = LANDMARK_INDEX.get(name)
    if idx is None or idx >= len(landmarks):
        return None
    lm = landmarks[idx]
    return (lm.x, lm.y)


def _compute_joint_angles(landmarks: list[LandmarkPoint], shot_type: str) -> list[JointAngleResult]:
    """
    Iterate over JOINT_DEFINITIONS, compute the angle at each vertex joint,
    and compare against shot_type benchmarks to classify quality.
    """
    results: list[JointAngleResult] = []
    benchmarks = INLINE_BENCHMARKS.get(shot_type, {})

    for joint_name, lm_a, lm_b, lm_c in JOINT_DEFINITIONS:
        coords_a = _get_landmark_coords(landmarks, lm_a)
        coords_b = _get_landmark_coords(landmarks, lm_b)
        coords_c = _get_landmark_coords(landmarks, lm_c)

        if coords_a is None or coords_b is None or coords_c is None:
            continue  # Skip if any landmark is missing

        angle = calculate_joint_angle(
            a=np.array(coords_a),
            b=np.array(coords_b),
            c=np.array(coords_c),
        )

        # Default classification when no benchmark exists for this joint
        quality = "UNCLASSIFIED"
        deviation = 0.0
        opt_min = opt_max = None

        if joint_name in benchmarks:
            opt_min, opt_max, warn_tol, crit_tol = benchmarks[joint_name]
            quality, deviation = classify_angle_quality(
                angle=angle,
                optimal_min=opt_min,
                optimal_max=opt_max,
                warning_tolerance=warn_tol,
                critical_tolerance=crit_tol,
            )

        results.append(JointAngleResult(
            joint_name=joint_name,
            landmark_a=lm_a,
            landmark_b=lm_b,
            landmark_c=lm_c,
            angle_degrees=round(angle, 2),
            quality=quality,
            deviation_degrees=round(deviation, 2),
            optimal_min=opt_min,
            optimal_max=opt_max,
        ))

    return results


# ---------------------------------------------------------------------------
# Dev entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
