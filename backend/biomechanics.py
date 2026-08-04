"""
StanceAI — Biomechanics Core Engine
=====================================
Vector-geometry utilities for computing joint angles from 2D/3D skeletal
landmarks produced by MediaPipe Pose.

All functions operate on NumPy arrays and are framework-agnostic, making
them easily unit-testable and reusable across REST and WebSocket handlers.

Joint Angle Definition
----------------------
Given three points A, B, C where B is the vertex joint:

    A ←── B ──→ C

    Vector BA = A - B
    Vector BC = C - B

    angle(B) = arccos( (BA · BC) / (|BA| × |BC|) )

This gives the interior angle at joint B in degrees (0°–180°).

Quality Classification
----------------------
Angles are classified against a benchmark range [optimal_min, optimal_max]:

    ┌────────────────────────────────────────────────────────────────┐
    │ OPTIMAL  │ within [optimal_min, optimal_max]                  │
    │ WARNING  │ deviation > 0 and ≤ warning_tolerance              │
    │ CRITICAL │ deviation > warning_tolerance (up to crit_tol)     │
    └────────────────────────────────────────────────────────────────┘

Color coding (for frontend canvas rendering):
    OPTIMAL      → #00E676  (vivid green)
    WARNING      → #FFD600  (amber)
    CRITICAL     → #FF1744  (red)
    UNCLASSIFIED → #90A4AE  (cool grey)
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np

# ---------------------------------------------------------------------------
# MediaPipe Pose — 33-landmark connection topology
# (mirrored from mediapipe.solutions.pose.POSE_CONNECTIONS)
# Used by the frontend SkeletonOverlay canvas renderer.
# ---------------------------------------------------------------------------
MEDIAPIPE_CONNECTIONS: list[tuple[int, int]] = [
    # Face
    (0, 1), (1, 2), (2, 3), (3, 7),
    (0, 4), (4, 5), (5, 6), (6, 8),
    (9, 10),
    # Upper body
    (11, 12),
    (11, 13), (13, 15), (15, 17), (15, 19), (15, 21), (17, 19),
    (12, 14), (14, 16), (16, 18), (16, 20), (16, 22), (18, 20),
    # Torso
    (11, 23), (12, 24), (23, 24),
    # Lower body
    (23, 25), (25, 27), (27, 29), (29, 31), (27, 31),
    (24, 26), (26, 28), (28, 30), (30, 32), (28, 32),
]

# ---------------------------------------------------------------------------
# Quality classification color palette
# ---------------------------------------------------------------------------
QUALITY_COLORS: dict[str, str] = {
    "OPTIMAL":      "#00E676",   # Vivid green
    "WARNING":      "#FFD600",   # Amber
    "CRITICAL":     "#FF1744",   # Red
    "UNCLASSIFIED": "#90A4AE",   # Cool grey
}


# ---------------------------------------------------------------------------
# Core: Joint Angle Calculation
# ---------------------------------------------------------------------------

def calculate_joint_angle(
    a: np.ndarray,
    b: np.ndarray,
    c: np.ndarray,
) -> float:
    """
    Calculate the interior angle (in degrees) at the vertex joint B,
    formed by the line segments A→B and C→B.

    Uses dot-product / vector cosine formula — robust for both 2D (x, y)
    and 3D (x, y, z) coordinate arrays.

    Parameters
    ----------
    a : np.ndarray
        Coordinates of point A (e.g., Shoulder). Shape: (2,) or (3,).
    b : np.ndarray
        Coordinates of the vertex joint B (e.g., Elbow). Shape: (2,) or (3,).
    c : np.ndarray
        Coordinates of point C (e.g., Wrist). Shape: (2,) or (3,).

    Returns
    -------
    float
        Angle at B in degrees, in the range [0.0, 180.0].

    Raises
    ------
    ValueError
        If any input array is not 1-D, or if dimensions are mismatched.

    Example
    -------
    >>> import numpy as np
    >>> shoulder = np.array([0.5, 0.3])
    >>> elbow    = np.array([0.6, 0.5])
    >>> wrist    = np.array([0.8, 0.4])
    >>> angle = calculate_joint_angle(shoulder, elbow, wrist)
    >>> print(f"Elbow angle: {angle:.1f}°")
    """
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    c = np.asarray(c, dtype=float)

    if a.ndim != 1 or b.ndim != 1 or c.ndim != 1:
        raise ValueError("Input arrays must be 1-dimensional coordinate vectors.")

    if not (a.shape == b.shape == c.shape):
        raise ValueError(
            f"Coordinate dimension mismatch: a={a.shape}, b={b.shape}, c={c.shape}."
        )

    # Vectors from vertex B to endpoints A and C
    ba: np.ndarray = a - b
    bc: np.ndarray = c - b

    # Norms — guard against zero-length vectors (degenerate pose)
    norm_ba = np.linalg.norm(ba)
    norm_bc = np.linalg.norm(bc)

    if norm_ba < 1e-9 or norm_bc < 1e-9:
        # Points are coincident — angle is undefined; return 0
        return 0.0

    # Cosine of the angle via dot product
    cos_theta = np.dot(ba, bc) / (norm_ba * norm_bc)

    # Clamp to [-1, 1] to guard against floating-point rounding outside domain
    cos_theta = float(np.clip(cos_theta, -1.0, 1.0))

    # Convert from radians to degrees
    angle_deg = math.degrees(math.acos(cos_theta))

    return angle_deg


# ---------------------------------------------------------------------------
# Quality Classification
# ---------------------------------------------------------------------------

def classify_angle_quality(
    angle: float,
    optimal_min: float,
    optimal_max: float,
    warning_tolerance: float = 10.0,
    critical_tolerance: float = 20.0,
) -> tuple[str, float]:
    """
    Classify a measured joint angle against a benchmark range.

    Parameters
    ----------
    angle : float
        The measured joint angle in degrees.
    optimal_min : float
        Lower bound of the optimal range (degrees).
    optimal_max : float
        Upper bound of the optimal range (degrees).
    warning_tolerance : float
        Degrees of deviation beyond the optimal range before escalating to WARNING.
    critical_tolerance : float
        Degrees of deviation beyond the optimal range before escalating to CRITICAL.

    Returns
    -------
    tuple[str, float]
        - quality : One of 'OPTIMAL', 'WARNING', 'CRITICAL'
        - deviation : Absolute deviation from the nearest optimal boundary (0 if OPTIMAL)

    Examples
    --------
    >>> classify_angle_quality(120.0, 100.0, 140.0)
    ('OPTIMAL', 0.0)

    >>> classify_angle_quality(148.0, 100.0, 140.0, warning_tolerance=10.0)
    ('WARNING', 8.0)

    >>> classify_angle_quality(175.0, 100.0, 140.0, warning_tolerance=10.0, critical_tolerance=20.0)
    ('CRITICAL', 35.0)
    """
    # Clamp: compute deviation from nearest optimal boundary
    if optimal_min <= angle <= optimal_max:
        return ("OPTIMAL", 0.0)

    # Deviation from nearest boundary
    if angle < optimal_min:
        deviation = optimal_min - angle
    else:
        deviation = angle - optimal_max

    # Classify by severity
    if deviation <= warning_tolerance:
        return ("WARNING", deviation)
    else:
        return ("CRITICAL", deviation)


# ---------------------------------------------------------------------------
# Landmark Extraction Helper
# ---------------------------------------------------------------------------

def extract_landmarks(pose_results) -> list[dict]:
    """
    Extract MediaPipe Pose landmark data into a serialisable list of dicts.

    Each dict contains:
        index  : int   — Landmark index (0–32)
        x      : float — Normalised x (0.0–1.0, left→right)
        y      : float — Normalised y (0.0–1.0, top→bottom)
        z      : float — Depth relative to hip midpoint
        visibility : float — Landmark visibility confidence (0.0–1.0)

    Parameters
    ----------
    pose_results : mediapipe.python.solution_base.SolutionOutputs
        The raw output from mp.solutions.pose.Pose.process(frame).

    Returns
    -------
    list[dict]
        List of 33 landmark dicts, or empty list if no pose was detected.
    """
    if pose_results is None or pose_results.pose_landmarks is None:
        return []

    landmarks = []
    for idx, lm in enumerate(pose_results.pose_landmarks.landmark):
        landmarks.append({
            "index":      idx,
            "x":          float(lm.x),
            "y":          float(lm.y),
            "z":          float(lm.z),
            "visibility": float(lm.visibility),
        })
    return landmarks


# ---------------------------------------------------------------------------
# Batch: Compute multiple joint angles in one call
# ---------------------------------------------------------------------------

def compute_angles_from_landmark_dict(
    landmarks: list[dict],
    joint_definitions: list[tuple[str, int, int, int]],
) -> list[dict]:
    """
    Compute multiple joint angles from a list of landmark dicts.

    Parameters
    ----------
    landmarks : list[dict]
        List of landmark dicts (as returned by extract_landmarks).
    joint_definitions : list[tuple[str, int, int, int]]
        Each tuple: (joint_name, index_a, index_b_vertex, index_c)

    Returns
    -------
    list[dict]
        Each item: { joint_name, index_a, index_b, index_c, angle_degrees }

    Example
    -------
    joints = [("FRONT_ELBOW", 11, 13, 15)]  # shoulder→elbow→wrist
    angles = compute_angles_from_landmark_dict(landmarks, joints)
    """
    results = []

    for joint_name, idx_a, idx_b, idx_c in joint_definitions:
        if max(idx_a, idx_b, idx_c) >= len(landmarks):
            continue  # Skip if landmark index out of range

        lm_a = landmarks[idx_a]
        lm_b = landmarks[idx_b]
        lm_c = landmarks[idx_c]

        # Use x, y (2D normalised image coords)
        a = np.array([lm_a["x"], lm_a["y"]])
        b = np.array([lm_b["x"], lm_b["y"]])
        c = np.array([lm_c["x"], lm_c["y"]])

        angle = calculate_joint_angle(a, b, c)
        results.append({
            "joint_name":    joint_name,
            "index_a":       idx_a,
            "index_b":       idx_b,
            "index_c":       idx_c,
            "angle_degrees": round(angle, 3),
        })

    return results
