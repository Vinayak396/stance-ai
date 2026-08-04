-- =============================================================
-- StanceAI — Supabase / PostgreSQL Schema
-- Biomechanical Cricket Analyzer
-- =============================================================
-- Run this entire script once in the Supabase SQL Editor:
--   Dashboard → SQL Editor → Paste → Run
-- =============================================================


-- -------------------------------------------------------------
-- TABLE: shot_benchmarks
-- Optimal biomechanical angle ranges per cricket shot & joint.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shot_benchmarks (
    benchmark_id        INTEGER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shot_type           VARCHAR(100)    NOT NULL,
    joint_name          VARCHAR(100)    NOT NULL,
    landmark_a          VARCHAR(50)     NOT NULL,
    landmark_b          VARCHAR(50)     NOT NULL,
    landmark_c          VARCHAR(50)     NOT NULL,
    optimal_angle_min   NUMERIC(6, 2)   NOT NULL,
    optimal_angle_max   NUMERIC(6, 2)   NOT NULL,
    warning_tolerance   NUMERIC(6, 2)   NOT NULL DEFAULT 10.0,
    critical_tolerance  NUMERIC(6, 2)   NOT NULL DEFAULT 20.0,
    description         TEXT,
    source_reference    VARCHAR(255),
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_angle_range  CHECK (optimal_angle_min < optimal_angle_max),
    CONSTRAINT chk_tolerances   CHECK (warning_tolerance >= 0 AND critical_tolerance >= warning_tolerance),
    CONSTRAINT uq_shot_joint    UNIQUE (shot_type, joint_name)
);

ALTER TABLE shot_benchmarks ENABLE ROW LEVEL SECURITY;

-- Allow anonymous reads (public benchmarks)
CREATE POLICY "Public read shot_benchmarks"
    ON shot_benchmarks FOR SELECT
    USING (true);


-- -------------------------------------------------------------
-- TABLE: analysis_sessions
-- One row per webcam / video analysis session per user.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analysis_sessions (
    session_id          INTEGER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_identifier     VARCHAR(255)    NOT NULL,
    shot_type           VARCHAR(100),
    input_source        VARCHAR(50)     NOT NULL DEFAULT 'WEBCAM'
                            CHECK (input_source IN ('WEBCAM', 'VIDEO_UPLOAD', 'IMAGE')),
    total_frames        INTEGER         NOT NULL DEFAULT 0,
    flagged_frames      INTEGER         NOT NULL DEFAULT 0,
    session_status      VARCHAR(50)     NOT NULL DEFAULT 'IN_PROGRESS'
                            CHECK (session_status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED')),
    overall_score       NUMERIC(5, 2)   CHECK (overall_score IS NULL OR overall_score BETWEEN 0 AND 100),
    notes               TEXT,
    metadata            JSONB,
    started_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_frame_counts CHECK (flagged_frames <= total_frames)
);

ALTER TABLE analysis_sessions ENABLE ROW LEVEL SECURITY;

-- Allow anonymous read + write (tighten with Supabase Auth later)
CREATE POLICY "Public read analysis_sessions"
    ON analysis_sessions FOR SELECT
    USING (true);

CREATE POLICY "Public insert analysis_sessions"
    ON analysis_sessions FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Public update analysis_sessions"
    ON analysis_sessions FOR UPDATE
    USING (true);


-- -------------------------------------------------------------
-- TABLE: session_anomalies
-- One row per biomechanical anomaly detected per frame.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_anomalies (
    anomaly_id          INTEGER         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id          INTEGER         NOT NULL REFERENCES analysis_sessions(session_id) ON DELETE CASCADE,
    benchmark_id        INTEGER         REFERENCES shot_benchmarks(benchmark_id),
    frame_number        INTEGER         NOT NULL,
    frame_timestamp_ms  INTEGER,
    joint_name          VARCHAR(100)    NOT NULL,
    observed_angle      NUMERIC(7, 3)   NOT NULL,
    optimal_angle_min   NUMERIC(6, 2),
    optimal_angle_max   NUMERIC(6, 2),
    deviation_degrees   NUMERIC(7, 3)   NOT NULL,
    severity            VARCHAR(20)     NOT NULL CHECK (severity IN ('WARNING', 'CRITICAL')),
    landmark_data       JSONB,
    feedback_message    TEXT,
    detected_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_session   ON session_anomalies(session_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_severity  ON session_anomalies(session_id, severity);
CREATE INDEX IF NOT EXISTS idx_anomaly_joint     ON session_anomalies(joint_name);

ALTER TABLE session_anomalies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read session_anomalies"
    ON session_anomalies FOR SELECT
    USING (true);

CREATE POLICY "Public insert session_anomalies"
    ON session_anomalies FOR INSERT
    WITH CHECK (true);


-- =============================================================
-- SEED DATA: Shot Benchmarks
-- =============================================================
-- The full research-backed benchmark dataset (50 rows, 10 shot types)
-- is stored in database/benchmarks.csv and imported via:
--
--   node database/import_benchmarks.js
--
-- Run that script AFTER executing this schema file.
-- It performs an upsert so it is safe to run multiple times.
--
-- If you want a minimal test seed (4 rows), uncomment below:
-- =============================================================

-- INSERT INTO shot_benchmarks (
--     shot_type, joint_name, landmark_a, landmark_b, landmark_c,
--     optimal_angle_min, optimal_angle_max, warning_tolerance, critical_tolerance,
--     description, source_reference
-- ) VALUES
-- ('COVER_DRIVE','FRONT_ELBOW','LEFT_SHOULDER','LEFT_ELBOW','LEFT_WRIST',
--  100.0, 140.0, 15.0, 30.0,
--  'Front elbow angle during cover drive follow-through.',
--  'MCC Coaching Manual 2022'),
-- ('COVER_DRIVE','FRONT_KNEE','LEFT_HIP','LEFT_KNEE','LEFT_ANKLE',
--  130.0, 162.0, 10.0, 22.0,
--  'Front knee bend at contact for cover drive.',
--  'ECB Level 3 2021'),
-- ('PULL_SHOT','BACK_ELBOW','RIGHT_SHOULDER','RIGHT_ELBOW','RIGHT_WRIST',
--  85.0, 120.0, 15.0, 30.0,
--  'Back elbow elevation during pull shot.',
--  'ECB Level 3 2021'),
-- ('FORWARD_DEFENSE','FRONT_ELBOW','LEFT_SHOULDER','LEFT_ELBOW','LEFT_WRIST',
--  58.0, 100.0, 10.0, 20.0,
--  'Front elbow during forward defensive stroke.',
--  'Cricket Australia Guide 2023')
-- ON CONFLICT (shot_type, joint_name) DO NOTHING;

