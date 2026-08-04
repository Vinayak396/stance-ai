"""
StanceAI — Oracle Database Layer
==================================
Manages Oracle DB connectivity (thin client — no Instant Client required)
and provides CRUD helpers for:
  - SHOT_BENCHMARKS
  - USER_ANALYSIS_SESSIONS
  - SESSION_ANOMALIES

Connection is pool-based using oracledb.create_pool() for production use.
For development/testing, a simple single connection is used if pool config
is not provided.

Configuration (via environment variables):
    ORACLE_USER         — Database username (e.g., STANCEAI_USER)
    ORACLE_PASSWORD     — Database password
    ORACLE_DSN          — DSN string (e.g., localhost/XEPDB1 or cloud wallet alias)
    ORACLE_POOL_MIN     — Minimum pool connections (default: 2)
    ORACLE_POOL_MAX     — Maximum pool connections (default: 10)
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from typing import Any, Generator, Optional

try:
    import oracledb
    ORACLE_AVAILABLE = True
except ImportError:
    ORACLE_AVAILABLE = False

from models import AnomalyReport, BenchmarkEntry

logger = logging.getLogger("stanceai.database")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ORACLE_USER     = os.getenv("ORACLE_USER", "stanceai_user")
ORACLE_PASSWORD = os.getenv("ORACLE_PASSWORD", "")
ORACLE_DSN      = os.getenv("ORACLE_DSN", "localhost/XEPDB1")
POOL_MIN        = int(os.getenv("ORACLE_POOL_MIN", "2"))
POOL_MAX        = int(os.getenv("ORACLE_POOL_MAX", "10"))

# Singleton pool reference
_pool: Optional[Any] = None


# ---------------------------------------------------------------------------
# Pool Management
# ---------------------------------------------------------------------------

def init_pool() -> None:
    """
    Initialise the Oracle connection pool.
    Call this once at application startup (in the FastAPI lifespan handler).
    """
    global _pool

    if not ORACLE_AVAILABLE:
        logger.warning(
            "oracledb package not installed — database features disabled."
        )
        return

    if not ORACLE_PASSWORD:
        logger.warning(
            "ORACLE_PASSWORD environment variable not set — skipping DB pool init."
        )
        return

    try:
        _pool = oracledb.create_pool(
            user=ORACLE_USER,
            password=ORACLE_PASSWORD,
            dsn=ORACLE_DSN,
            min=POOL_MIN,
            max=POOL_MAX,
            increment=1,
        )
        logger.info(
            f"Oracle connection pool initialised: user={ORACLE_USER}, dsn={ORACLE_DSN}, "
            f"min={POOL_MIN}, max={POOL_MAX}"
        )
    except Exception as e:
        logger.error(f"Failed to initialise Oracle connection pool: {e}")
        _pool = None


def close_pool() -> None:
    """Close the Oracle connection pool. Call during application shutdown."""
    global _pool
    if _pool is not None:
        try:
            _pool.close()
            logger.info("Oracle connection pool closed.")
        except Exception as e:
            logger.error(f"Error closing Oracle pool: {e}")
        finally:
            _pool = None


@contextmanager
def get_connection() -> Generator[Any, None, None]:
    """
    Context manager that yields a database connection.
    Acquires from pool if available; otherwise raises a RuntimeError.

    Usage
    -----
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM DUAL")
    """
    if _pool is None:
        raise RuntimeError(
            "Oracle connection pool is not initialised. "
            "Ensure ORACLE_PASSWORD is set and init_pool() was called."
        )
    conn = _pool.acquire()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.release(conn)


# ---------------------------------------------------------------------------
# SHOT_BENCHMARKS CRUD
# ---------------------------------------------------------------------------

def get_benchmarks(shot_type: Optional[str] = None) -> list[BenchmarkEntry]:
    """
    Fetch shot benchmarks from Oracle.

    Parameters
    ----------
    shot_type : str, optional
        Filter by shot type. Returns all active benchmarks if None.

    Returns
    -------
    list[BenchmarkEntry]
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            if shot_type:
                cur.execute(
                    """
                    SELECT benchmark_id, shot_type, joint_name,
                           landmark_a, landmark_b, landmark_c,
                           optimal_angle_min, optimal_angle_max,
                           warning_tolerance, critical_tolerance,
                           description, source_reference
                    FROM   SHOT_BENCHMARKS
                    WHERE  shot_type = :shot_type
                    AND    is_active = 1
                    ORDER  BY joint_name
                    """,
                    {"shot_type": shot_type.upper()},
                )
            else:
                cur.execute(
                    """
                    SELECT benchmark_id, shot_type, joint_name,
                           landmark_a, landmark_b, landmark_c,
                           optimal_angle_min, optimal_angle_max,
                           warning_tolerance, critical_tolerance,
                           description, source_reference
                    FROM   SHOT_BENCHMARKS
                    WHERE  is_active = 1
                    ORDER  BY shot_type, joint_name
                    """
                )

            rows = cur.fetchall()
            return [
                BenchmarkEntry(
                    benchmark_id=r[0],
                    shot_type=r[1],
                    joint_name=r[2],
                    landmark_a=r[3],
                    landmark_b=r[4],
                    landmark_c=r[5],
                    optimal_angle_min=float(r[6]),
                    optimal_angle_max=float(r[7]),
                    warning_tolerance=float(r[8]),
                    critical_tolerance=float(r[9]),
                    description=r[10],
                    source_reference=r[11],
                )
                for r in rows
            ]


# ---------------------------------------------------------------------------
# USER_ANALYSIS_SESSIONS CRUD
# ---------------------------------------------------------------------------

def create_session(
    user_identifier: str,
    shot_type: Optional[str] = None,
    input_source: str = "WEBCAM",
    notes: Optional[str] = None,
) -> int:
    """
    Insert a new analysis session row and return the generated session_id.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO USER_ANALYSIS_SESSIONS
                    (user_identifier, shot_type, input_source, notes, session_status)
                VALUES
                    (:user_id, :shot_type, :input_src, :notes, 'IN_PROGRESS')
                RETURNING session_id INTO :sess_id
                """,
                {
                    "user_id":   user_identifier,
                    "shot_type": shot_type,
                    "input_src": input_source.upper(),
                    "notes":     notes,
                    "sess_id":   cur.var(int),
                },
            )
            session_id: int = cur.bindvars["sess_id"].getvalue()
            logger.info(f"Created session {session_id} for user '{user_identifier}'.")
            return session_id


def end_session(
    session_id: int,
    total_frames: int,
    flagged_frames: int,
    overall_score: Optional[float] = None,
    status: str = "COMPLETED",
) -> None:
    """Update a session row with final statistics and mark it complete."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE USER_ANALYSIS_SESSIONS
                SET    total_frames   = :total_frames,
                       flagged_frames = :flagged,
                       overall_score  = :score,
                       session_status = :status,
                       completed_at   = SYSTIMESTAMP
                WHERE  session_id = :sid
                """,
                {
                    "total_frames": total_frames,
                    "flagged":      flagged_frames,
                    "score":        overall_score,
                    "status":       status.upper(),
                    "sid":          session_id,
                },
            )
            logger.info(f"Session {session_id} ended with status={status}.")


# ---------------------------------------------------------------------------
# SESSION_ANOMALIES CRUD
# ---------------------------------------------------------------------------

def log_anomaly(anomaly: AnomalyReport, benchmark_id: Optional[int] = None) -> int:
    """
    Insert a single anomaly record and return its anomaly_id.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO SESSION_ANOMALIES (
                    session_id, benchmark_id, frame_number, frame_timestamp_ms,
                    joint_name, observed_angle, optimal_angle_min, optimal_angle_max,
                    deviation_degrees, severity, feedback_message
                ) VALUES (
                    :sid, :bid, :frame_no, :ts_ms,
                    :joint, :obs_angle, :opt_min, :opt_max,
                    :dev, :severity, :msg
                ) RETURNING anomaly_id INTO :aid
                """,
                {
                    "sid":       anomaly.session_id,
                    "bid":       benchmark_id,
                    "frame_no":  anomaly.frame_number,
                    "ts_ms":     anomaly.frame_timestamp_ms,
                    "joint":     anomaly.joint_name,
                    "obs_angle": anomaly.observed_angle,
                    "opt_min":   anomaly.optimal_min,
                    "opt_max":   anomaly.optimal_max,
                    "dev":       anomaly.deviation_degrees,
                    "severity":  anomaly.severity,
                    "msg":       anomaly.feedback_message,
                    "aid":       cur.var(int),
                },
            )
            anomaly_id: int = cur.bindvars["aid"].getvalue()
            logger.debug(
                f"Logged anomaly {anomaly_id}: session={anomaly.session_id}, "
                f"joint={anomaly.joint_name}, severity={anomaly.severity}"
            )
            return anomaly_id


def get_session_anomalies(session_id: int) -> list[dict]:
    """Fetch all anomalies for a given session_id."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT anomaly_id, frame_number, joint_name,
                       observed_angle, deviation_degrees, severity, feedback_message
                FROM   SESSION_ANOMALIES
                WHERE  session_id = :sid
                ORDER  BY frame_number, anomaly_id
                """,
                {"sid": session_id},
            )
            rows = cur.fetchall()
            return [
                {
                    "anomaly_id":       r[0],
                    "frame_number":     r[1],
                    "joint_name":       r[2],
                    "observed_angle":   float(r[3]),
                    "deviation_degrees": float(r[4]),
                    "severity":         r[5],
                    "feedback_message": r[6],
                }
                for r in rows
            ]
