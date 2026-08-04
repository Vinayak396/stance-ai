"""
StanceAI — Pydantic Models
============================
Request/response schemas for the FastAPI application.
Uses Pydantic v2 (model_config instead of class Config).
"""

from __future__ import annotations

from typing import Optional
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------

class HealthResponse(BaseModel):
    status: str = Field(..., examples=["ok"])
    version: str = Field(..., examples=["0.1.0"])
    service: str = Field(..., examples=["StanceAI Biomechanical Analyzer"])
    mediapipe_ready: bool = Field(..., description="True if MediaPipe Pose is initialised")


# ---------------------------------------------------------------------------
# Landmarks
# ---------------------------------------------------------------------------

class LandmarkPoint(BaseModel):
    index: int = Field(..., ge=0, le=32, description="MediaPipe landmark index (0–32)")
    x: float = Field(..., description="Normalised x coordinate (0.0–1.0)")
    y: float = Field(..., description="Normalised y coordinate (0.0–1.0)")
    z: float = Field(default=0.0, description="Depth relative to hip midpoint")
    visibility: float = Field(default=1.0, ge=0.0, le=1.0, description="Landmark visibility confidence")


# ---------------------------------------------------------------------------
# Joint Angle Result
# ---------------------------------------------------------------------------

class JointAngleResult(BaseModel):
    joint_name: str = Field(..., examples=["FRONT_ELBOW"])
    landmark_a: str = Field(..., examples=["LEFT_SHOULDER"])
    landmark_b: str = Field(..., examples=["LEFT_ELBOW"])
    landmark_c: str = Field(..., examples=["LEFT_WRIST"])
    angle_degrees: float = Field(..., description="Computed angle at vertex B, in degrees")
    quality: str = Field(
        ...,
        description="Quality classification: OPTIMAL | WARNING | CRITICAL | UNCLASSIFIED",
        examples=["OPTIMAL"],
    )
    deviation_degrees: float = Field(
        default=0.0,
        description="Deviation from optimal boundary. 0 if OPTIMAL.",
    )
    optimal_min: Optional[float] = Field(default=None, description="Benchmark min angle")
    optimal_max: Optional[float] = Field(default=None, description="Benchmark max angle")


# ---------------------------------------------------------------------------
# Analyze Endpoint
# ---------------------------------------------------------------------------

class AnalyzeRequest(BaseModel):
    """Used internally; the actual endpoint uses multipart form data."""
    shot_type: str = Field(default="COVER_DRIVE", examples=["COVER_DRIVE", "PULL_SHOT"])
    session_id: Optional[int] = Field(default=None, description="Existing session ID")


class AnalyzeResponse(BaseModel):
    success: bool
    message: str
    landmarks: list[LandmarkPoint] = Field(default_factory=list)
    joint_angles: list[JointAngleResult] = Field(default_factory=list)
    annotated_frame_b64: Optional[str] = Field(
        default=None,
        description="Base64-encoded JPEG of the frame annotated with skeleton overlay",
    )
    shot_type: Optional[str] = None
    session_id: Optional[int] = None


# ---------------------------------------------------------------------------
# Session Management
# ---------------------------------------------------------------------------

class SessionStartRequest(BaseModel):
    user_identifier: str = Field(..., description="Unique user/batter ID")
    shot_type: Optional[str] = Field(default=None, description="Cricket shot type to analyze")
    input_source: str = Field(
        default="WEBCAM",
        description="Source of footage: WEBCAM | VIDEO_UPLOAD | IMAGE",
    )
    notes: Optional[str] = Field(default=None, description="Optional session notes")


class SessionStartResponse(BaseModel):
    session_id: int
    user_identifier: str
    shot_type: Optional[str]
    input_source: str
    status: str = "IN_PROGRESS"
    message: str = "Session started successfully."


# ---------------------------------------------------------------------------
# Anomaly Report
# ---------------------------------------------------------------------------

class AnomalyReport(BaseModel):
    session_id: int
    frame_number: int
    frame_timestamp_ms: Optional[int] = None
    joint_name: str
    observed_angle: float
    optimal_min: Optional[float] = None
    optimal_max: Optional[float] = None
    deviation_degrees: float
    severity: str = Field(..., description="WARNING | CRITICAL")
    feedback_message: Optional[str] = None


# ---------------------------------------------------------------------------
# Benchmark Entry
# ---------------------------------------------------------------------------

class BenchmarkEntry(BaseModel):
    benchmark_id: Optional[int] = None
    shot_type: str
    joint_name: str
    landmark_a: str
    landmark_b: str
    landmark_c: str
    optimal_angle_min: float
    optimal_angle_max: float
    warning_tolerance: float = 10.0
    critical_tolerance: float = 20.0
    description: Optional[str] = None
    source_reference: Optional[str] = None
    is_active: bool = True
