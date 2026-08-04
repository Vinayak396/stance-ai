/**
 * StanceAI — Biomechanics API (Supabase)
 * ========================================
 * Replaces the previous Axios/FastAPI client.
 * All data operations now go directly to Supabase via supabase-js.
 *
 * Functions:
 *   getBenchmarks(shotType)          → BenchmarkEntry[]
 *   startSession(userId, shotType)   → { session_id, ... }
 *   endSession(sessionId, stats)     → void
 *   logAnomaly(anomaly)              → { anomaly_id }
 *   getSessionAnomalies(sessionId)   → Anomaly[]
 *   getRecentSessions(userId, limit) → Session[]
 */

import { supabase } from '../lib/supabaseClient.js';

// ─── Benchmarks ──────────────────────────────────────────────────────────────

/**
 * Fetch shot benchmarks from Supabase.
 * Returns a benchmark map keyed by joint_name for easy lookup:
 * { FRONT_ELBOW: [optMin, optMax, warnTol, critTol], ... }
 *
 * @param {string} shotType - e.g. 'COVER_DRIVE'
 * @returns {Promise<Object>} Benchmark map (empty object if none found)
 */
export async function getBenchmarks(shotType) {
  const { data, error } = await supabase
    .from('shot_benchmarks')
    .select('joint_name, optimal_angle_min, optimal_angle_max, warning_tolerance, critical_tolerance')
    .eq('shot_type', shotType.toUpperCase())
    .eq('is_active', true)
    .order('joint_name');

  if (error) {
    console.error('[StanceAI DB] getBenchmarks error:', error.message);
    return {};
  }

  // Convert rows → { JOINT_NAME: [optMin, optMax, warnTol, critTol] }
  return Object.fromEntries(
    data.map(row => [
      row.joint_name,
      [row.optimal_angle_min, row.optimal_angle_max, row.warning_tolerance, row.critical_tolerance],
    ])
  );
}


// ─── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Create a new analysis session.
 *
 * @param {string}  userIdentifier - User ID / email / anonymous ID
 * @param {string}  shotType       - Cricket shot type
 * @param {string}  [inputSource]  - 'WEBCAM' | 'VIDEO_UPLOAD' | 'IMAGE'
 * @param {string}  [notes]        - Optional session notes
 * @returns {Promise<{ session_id: number, started_at: string }>}
 */
export async function startSession(
  userIdentifier,
  shotType,
  inputSource = 'WEBCAM',
  notes = null,
) {
  const { data, error } = await supabase
    .from('analysis_sessions')
    .insert({
      user_identifier: userIdentifier,
      shot_type:       shotType?.toUpperCase() ?? null,
      input_source:    inputSource.toUpperCase(),
      session_status:  'IN_PROGRESS',
      notes,
    })
    .select('session_id, started_at')
    .single();

  if (error) {
    console.error('[StanceAI DB] startSession error:', error.message);
    throw new Error(`Failed to start session: ${error.message}`);
  }

  return data;
}


/**
 * Update a session with final statistics and mark it complete.
 *
 * @param {number}  sessionId
 * @param {object}  stats
 * @param {number}  stats.totalFrames
 * @param {number}  stats.flaggedFrames
 * @param {number}  [stats.overallScore]  - 0–100
 * @param {string}  [stats.status]        - 'COMPLETED' | 'FAILED' | 'CANCELLED'
 */
export async function endSession(sessionId, {
  totalFrames   = 0,
  flaggedFrames = 0,
  overallScore  = null,
  status        = 'COMPLETED',
} = {}) {
  const { error } = await supabase
    .from('analysis_sessions')
    .update({
      total_frames:   totalFrames,
      flagged_frames: flaggedFrames,
      overall_score:  overallScore,
      session_status: status.toUpperCase(),
      completed_at:   new Date().toISOString(),
    })
    .eq('session_id', sessionId);

  if (error) {
    console.error('[StanceAI DB] endSession error:', error.message);
  }
}


// ─── Anomalies ────────────────────────────────────────────────────────────────

/**
 * Log a single biomechanical anomaly.
 *
 * @param {object} anomaly
 * @param {number} anomaly.sessionId
 * @param {number} anomaly.frameNumber
 * @param {number} [anomaly.frameTimestampMs]
 * @param {string} anomaly.jointName
 * @param {number} anomaly.observedAngle
 * @param {number} [anomaly.optimalMin]
 * @param {number} [anomaly.optimalMax]
 * @param {number} anomaly.deviationDegrees
 * @param {string} anomaly.severity  - 'WARNING' | 'CRITICAL'
 * @param {string} [anomaly.feedbackMessage]
 * @param {Array}  [anomaly.landmarkData]  - raw landmark snapshot
 * @returns {Promise<{ anomaly_id: number }>}
 */
export async function logAnomaly(anomaly) {
  const { data, error } = await supabase
    .from('session_anomalies')
    .insert({
      session_id:         anomaly.sessionId,
      frame_number:       anomaly.frameNumber,
      frame_timestamp_ms: anomaly.frameTimestampMs ?? null,
      joint_name:         anomaly.jointName,
      observed_angle:     anomaly.observedAngle,
      optimal_angle_min:  anomaly.optimalMin ?? null,
      optimal_angle_max:  anomaly.optimalMax ?? null,
      deviation_degrees:  anomaly.deviationDegrees,
      severity:           anomaly.severity,
      feedback_message:   anomaly.feedbackMessage ?? null,
      landmark_data:      anomaly.landmarkData ?? null,
    })
    .select('anomaly_id')
    .single();

  if (error) {
    console.error('[StanceAI DB] logAnomaly error:', error.message);
  }

  return data;
}


/**
 * Fetch all anomalies for a given session.
 *
 * @param {number} sessionId
 * @returns {Promise<Array>}
 */
export async function getSessionAnomalies(sessionId) {
  const { data, error } = await supabase
    .from('session_anomalies')
    .select('*')
    .eq('session_id', sessionId)
    .order('frame_number', { ascending: true });

  if (error) {
    console.error('[StanceAI DB] getSessionAnomalies error:', error.message);
    return [];
  }

  return data;
}


/**
 * Fetch recent sessions for a user (latest first).
 *
 * @param {string} userIdentifier
 * @param {number} [limit=10]
 * @returns {Promise<Array>}
 */
export async function getRecentSessions(userIdentifier, limit = 10) {
  const { data, error } = await supabase
    .from('analysis_sessions')
    .select('session_id, shot_type, session_status, overall_score, total_frames, flagged_frames, started_at, completed_at')
    .eq('user_identifier', userIdentifier)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[StanceAI DB] getRecentSessions error:', error.message);
    return [];
  }

  return data;
}
