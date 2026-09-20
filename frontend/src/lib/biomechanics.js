/**
 * StanceAI - Biomechanics Engine (Browser)
 * Runs entirely in the browser - no server required.
 *
 * computeJointAngles        - front camera: standard joint angles (unchanged)
 * computeSideViewMetrics     - side camera: ALL side-only insights (unchanged)
 * analyzeCompletedShot       - NEW: segments a recorded frame buffer into 3 phases
 *                              and returns per-phase metrics for the full shot.
 */

export const LANDMARK_INDEX = {
  NOSE: 0, LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7, RIGHT_EAR: 8, MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12, LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16, LEFT_PINKY: 17, RIGHT_PINKY: 18,
  LEFT_INDEX: 19, RIGHT_INDEX: 20, LEFT_THUMB: 21, RIGHT_THUMB: 22,
  LEFT_HIP: 23, RIGHT_HIP: 24, LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28, LEFT_HEEL: 29, RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};

export const FRONT_FOOT_SHOTS = new Set([
  'COVER_DRIVE', 'FORWARD_DEFENSE', 'STRAIGHT_DRIVE',
  'ON_DRIVE', 'LOFTED_DRIVE', 'FLICK_SHOT', 'DEFENSIVE_LEAVE',
]);

export const BACK_FOOT_SHOTS = new Set([
  'PULL_SHOT', 'CUT_SHOT', 'HOOK_SHOT', 'SWEEP_SHOT',
]);

export const JOINT_DEFINITIONS = [
  ['FRONT_ELBOW', 'LEFT_SHOULDER', 'LEFT_ELBOW', 'LEFT_WRIST'],
  ['BACK_ELBOW', 'RIGHT_SHOULDER', 'RIGHT_ELBOW', 'RIGHT_WRIST'],
  ['FRONT_KNEE', 'LEFT_HIP', 'LEFT_KNEE', 'LEFT_ANKLE'],
  ['BACK_KNEE', 'RIGHT_HIP', 'RIGHT_KNEE', 'RIGHT_ANKLE'],
  ['FRONT_HIP', 'LEFT_SHOULDER', 'LEFT_HIP', 'LEFT_KNEE'],
  ['BACK_HIP', 'RIGHT_SHOULDER', 'RIGHT_HIP', 'RIGHT_KNEE'],
  ['LEFT_SHOULDER', 'LEFT_ELBOW', 'LEFT_SHOULDER', 'LEFT_HIP'],
  ['RIGHT_SHOULDER', 'RIGHT_ELBOW', 'RIGHT_SHOULDER', 'RIGHT_HIP'],
];

// ── Phase definitions ──────────────────────────────────────────────────────────
// Which front-cam joint names are evaluated per phase.
export const PHASE_JOINTS = {
  STANCE: new Set(['FRONT_KNEE', 'BACK_KNEE', 'FRONT_HIP', 'BACK_HIP', 'LEFT_SHOULDER', 'RIGHT_SHOULDER']),
  STRIDE_SHOT: new Set(['FRONT_ELBOW', 'BACK_ELBOW', 'FRONT_KNEE', 'BACK_KNEE', 'FRONT_HIP', 'BACK_HIP']),
  FOLLOWTHROUGH: new Set(['FRONT_ELBOW', 'BACK_ELBOW', 'FRONT_HIP', 'LEFT_SHOULDER', 'RIGHT_SHOULDER', 'FRONT_KNEE']),
};

// Which side-cam metric names belong to each phase.
export const PHASE_SIDE_METRICS = {
  STANCE: new Set(['HEAD_POSITION', 'HIP_CROUCH', 'BODY_LEAN']),
  STRIDE_SHOT: new Set(['STRIDE_LENGTH', 'WEIGHT_TRANSFER', 'BACK_FOOT_SHIFT', 'FRONT_KNEE_DRIVE', 'BACK_KNEE_DEPTH', 'LEAD_ELBOW_TUCK']),
  FOLLOWTHROUGH: new Set(['BODY_LEAN', 'HIP_CROUCH', 'HEAD_POSITION']),
};

/**
 * INLINE_BENCHMARKS — per-shot benchmark ranges.
 *
 * Front-cam joints use degrees.
 * Side-cam metrics are normalised ratios scaled x180 to fit the 0-180 range bar:
 *
 *  Footwork (stride):
 *   STRIDE_LENGTH    = foot separation / hip-height * 180
 *   WEIGHT_TRANSFER  = hip-midpoint offset over foot span * 180 (0=back, 180=fully fwd)
 *   BACK_FOOT_SHIFT  = back-ankle offset behind hip-mid / hip-height * 180
 *
 *  Front-cam blind spots (all normalised / hip-height * 180 unless noted):
 *   HEAD_POSITION    = (nose.x - backAnkle.x) / footSpan * 180
 *                      how far head is over the ball line (0=above back foot, 180=above front)
 *   LEAD_ELBOW_TUCK  = (leadShoulder.x - leadElbow.x) / hipHeight * 180
 *                      elbow depth behind shoulder; 0=tucked tight, high=chicken-wing
 *   FRONT_KNEE_DRIVE = (frontKnee.x - frontAnkle.x) / hipHeight * 180
 *                      how far front knee drives over the toes (front-foot shots)
 *   BACK_KNEE_DEPTH  = (backKnee.x - backAnkle.x) / hipHeight * 180
 *                      how back knee pushes forward over toes (back-foot shots)
 *   HIP_CROUCH       = hipHeight / fullBodyHeight * 180
 *                      how deep the batsman crouches (higher = taller/more upright)
 *   BODY_LEAN        = torso angle from vertical (degrees, all shots)
 */
export const INLINE_BENCHMARKS = {
  COVER_DRIVE: {
    // Front-cam joints
    FRONT_ELBOW: [100, 140, 15, 30], BACK_ELBOW: [90, 130, 15, 30],
    FRONT_KNEE: [130, 162, 10, 22], BACK_KNEE: [118, 152, 12, 25],
    FRONT_HIP: [152, 174, 10, 20], BACK_HIP: [138, 162, 12, 25],
    LEFT_SHOULDER: [62, 98, 15, 30], RIGHT_SHOULDER: [55, 92, 15, 30],
    // Side-cam footwork
    STRIDE_LENGTH: [81, 135, 22, 45], WEIGHT_TRANSFER: [108, 144, 18, 36],
    // Side-cam blind spots
    HEAD_POSITION: [81, 126, 18, 36],    // head 45-70% over foot span
    LEAD_ELBOW_TUCK: [0, 27, 12, 25],    // tucked; <15% hip-height behind shoulder
    FRONT_KNEE_DRIVE: [18, 54, 15, 30],  // moderate drive over toe
    HIP_CROUCH: [90, 126, 15, 30],       // 50-70% hip-height ratio
    BODY_LEAN: [5, 20, 8, 16],
  },
  PULL_SHOT: {
    BACK_ELBOW: [85, 120, 15, 30], FRONT_ELBOW: [88, 125, 15, 30],
    FRONT_KNEE: [102, 140, 12, 25], BACK_KNEE: [98, 132, 12, 25],
    FRONT_HIP: [120, 155, 12, 25], BACK_HIP: [122, 155, 12, 25],
    LEFT_SHOULDER: [65, 102, 15, 30], RIGHT_SHOULDER: [58, 95, 15, 30],
    BACK_FOOT_SHIFT: [36, 90, 18, 36],
    HEAD_POSITION: [54, 99, 18, 36],     // head stays back
    LEAD_ELBOW_TUCK: [0, 36, 12, 25],
    BACK_KNEE_DEPTH: [18, 54, 15, 30],   // back knee over toe for pull
    HIP_CROUCH: [72, 108, 15, 30],       // lower crouch for pull
    BODY_LEAN: [0, 12, 8, 16],
  },
  FORWARD_DEFENSE: {
    FRONT_ELBOW: [58, 100, 10, 20], BACK_ELBOW: [78, 115, 12, 25],
    FRONT_KNEE: [118, 155, 10, 20], BACK_KNEE: [128, 158, 10, 20],
    FRONT_HIP: [142, 170, 12, 25], BACK_HIP: [140, 165, 10, 20],
    LEFT_SHOULDER: [52, 88, 12, 25], RIGHT_SHOULDER: [48, 82, 12, 25],
    STRIDE_LENGTH: [63, 117, 20, 40], WEIGHT_TRANSFER: [90, 135, 18, 36],
    HEAD_POSITION: [90, 135, 15, 30],    // head well over ball for defense
    LEAD_ELBOW_TUCK: [0, 27, 12, 25],
    FRONT_KNEE_DRIVE: [18, 54, 15, 30],
    HIP_CROUCH: [90, 126, 15, 30],
    BODY_LEAN: [8, 22, 8, 16],
  },
  SWEEP_SHOT: {
    FRONT_ELBOW: [78, 115, 15, 30], BACK_ELBOW: [68, 105, 15, 30],
    FRONT_KNEE: [78, 115, 12, 25], BACK_KNEE: [52, 88, 15, 30],
    FRONT_HIP: [112, 145, 15, 30], BACK_HIP: [90, 128, 15, 30],
    LEFT_SHOULDER: [58, 95, 15, 30], RIGHT_SHOULDER: [52, 88, 15, 30],
    BACK_FOOT_SHIFT: [18, 72, 18, 36],
    HEAD_POSITION: [72, 117, 18, 36],
    LEAD_ELBOW_TUCK: [0, 36, 15, 30],
    BACK_KNEE_DEPTH: [27, 72, 15, 30],
    HIP_CROUCH: [54, 90, 18, 36],        // very low for sweep
    BODY_LEAN: [10, 28, 10, 20],
  },
  CUT_SHOT: {
    BACK_ELBOW: [68, 108, 15, 30], FRONT_ELBOW: [95, 132, 15, 30],
    FRONT_KNEE: [132, 165, 10, 22], BACK_KNEE: [108, 145, 12, 25],
    FRONT_HIP: [128, 162, 12, 25], BACK_HIP: [128, 160, 12, 25],
    LEFT_SHOULDER: [62, 98, 15, 30], RIGHT_SHOULDER: [55, 92, 15, 30],
    BACK_FOOT_SHIFT: [27, 81, 18, 36],
    HEAD_POSITION: [54, 99, 18, 36],
    LEAD_ELBOW_TUCK: [0, 36, 15, 30],
    BACK_KNEE_DEPTH: [18, 54, 15, 30],
    HIP_CROUCH: [81, 117, 15, 30],
    BODY_LEAN: [0, 15, 8, 16],
  },
  STRAIGHT_DRIVE: {
    FRONT_ELBOW: [110, 150, 12, 25], FRONT_KNEE: [132, 165, 10, 20],
    BACK_KNEE: [122, 155, 12, 25],
    FRONT_HIP: [153, 175, 10, 20], BACK_HIP: [138, 162, 12, 25],
    LEFT_SHOULDER: [52, 88, 15, 30], RIGHT_SHOULDER: [48, 85, 15, 30],
    STRIDE_LENGTH: [81, 135, 22, 45], WEIGHT_TRANSFER: [108, 153, 18, 36],
    HEAD_POSITION: [90, 135, 15, 30],
    LEAD_ELBOW_TUCK: [0, 27, 12, 25],
    FRONT_KNEE_DRIVE: [18, 54, 15, 30],
    HIP_CROUCH: [90, 126, 15, 30],
    BODY_LEAN: [5, 18, 8, 16],
  },
  HOOK_SHOT: {
    BACK_ELBOW: [58, 98, 15, 30], FRONT_ELBOW: [78, 118, 15, 30],
    FRONT_KNEE: [98, 135, 15, 30], BACK_KNEE: [92, 128, 15, 30],
    FRONT_HIP: [115, 150, 12, 25], BACK_HIP: [108, 142, 15, 30],
    LEFT_SHOULDER: [60, 98, 15, 30], RIGHT_SHOULDER: [55, 92, 15, 30],
    BACK_FOOT_SHIFT: [36, 90, 18, 36],
    HEAD_POSITION: [45, 90, 18, 36],
    LEAD_ELBOW_TUCK: [0, 36, 15, 30],
    BACK_KNEE_DEPTH: [18, 54, 15, 30],
    HIP_CROUCH: [72, 108, 15, 30],
    BODY_LEAN: [0, 10, 8, 16],
  },
  ON_DRIVE: {
    FRONT_ELBOW: [88, 128, 15, 30], FRONT_KNEE: [118, 155, 12, 25],
    BACK_KNEE: [128, 158, 12, 25],
    FRONT_HIP: [148, 172, 10, 20], BACK_HIP: [138, 163, 12, 25],
    LEFT_SHOULDER: [58, 95, 15, 30], RIGHT_SHOULDER: [52, 88, 15, 30],
    STRIDE_LENGTH: [72, 126, 22, 45], WEIGHT_TRANSFER: [99, 144, 18, 36],
    HEAD_POSITION: [81, 126, 18, 36],
    LEAD_ELBOW_TUCK: [0, 27, 12, 25],
    FRONT_KNEE_DRIVE: [18, 54, 15, 30],
    HIP_CROUCH: [90, 126, 15, 30],
    BODY_LEAN: [5, 20, 8, 16],
  },
  LOFTED_DRIVE: {
    FRONT_ELBOW: [118, 155, 12, 25], FRONT_KNEE: [128, 160, 12, 25],
    BACK_KNEE: [118, 150, 15, 30],
    FRONT_HIP: [145, 172, 10, 20], BACK_HIP: [130, 158, 12, 25],
    LEFT_SHOULDER: [42, 78, 15, 30], RIGHT_SHOULDER: [38, 75, 15, 30],
    STRIDE_LENGTH: [72, 126, 22, 45], WEIGHT_TRANSFER: [99, 144, 18, 36],
    HEAD_POSITION: [72, 117, 18, 36],
    LEAD_ELBOW_TUCK: [0, 36, 15, 30],
    FRONT_KNEE_DRIVE: [27, 63, 15, 30],  // more drive for lofted
    HIP_CROUCH: [81, 117, 15, 30],
    BODY_LEAN: [8, 25, 8, 16],
  },
  FLICK_SHOT: {
    FRONT_ELBOW: [72, 108, 15, 30], FRONT_KNEE: [112, 148, 15, 30],
    FRONT_HIP: [138, 165, 15, 30], BACK_HIP: [132, 158, 15, 30],
    LEFT_SHOULDER: [55, 92, 15, 30], RIGHT_SHOULDER: [50, 87, 15, 30],
    STRIDE_LENGTH: [54, 108, 22, 45], WEIGHT_TRANSFER: [90, 135, 18, 36],
    HEAD_POSITION: [72, 117, 18, 36],
    LEAD_ELBOW_TUCK: [0, 27, 12, 25],
    FRONT_KNEE_DRIVE: [18, 54, 15, 30],
    HIP_CROUCH: [90, 126, 15, 30],
    BODY_LEAN: [5, 18, 8, 16],
  },
  DEFENSIVE_LEAVE: {
    FRONT_ELBOW: [65, 105, 12, 22], FRONT_KNEE: [125, 162, 10, 20],
    FRONT_HIP: [148, 172, 10, 20], BACK_HIP: [145, 170, 10, 20],
    LEFT_SHOULDER: [48, 82, 12, 25], RIGHT_SHOULDER: [42, 78, 12, 25],
    STRIDE_LENGTH: [36, 90, 20, 40], WEIGHT_TRANSFER: [81, 126, 18, 36],
    HEAD_POSITION: [63, 108, 18, 36],
    LEAD_ELBOW_TUCK: [0, 27, 12, 25],
    FRONT_KNEE_DRIVE: [9, 45, 15, 30],
    HIP_CROUCH: [99, 135, 15, 30],       // tall stance for leave
    BODY_LEAN: [3, 15, 8, 16],
  },
};

// Core math

export function calculateJointAngle(a, b, c) {
  const ba = [a[0] - b[0], a[1] - b[1]];
  const bc = [c[0] - b[0], c[1] - b[1]];
  const dot = ba[0] * bc[0] + ba[1] * bc[1];
  const magBA = Math.sqrt(ba[0] ** 2 + ba[1] ** 2);
  const magBC = Math.sqrt(bc[0] ** 2 + bc[1] ** 2);
  if (magBA === 0 || magBC === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot / (magBA * magBC)))) * 180) / Math.PI;
}

export function classifyAngleQuality(angle, optMin, optMax, warnTol, critTol) {
  if (angle >= optMin && angle <= optMax) return { quality: 'OPTIMAL', deviation: 0 };
  const deviation = angle < optMin ? optMin - angle : angle - optMax;
  if (deviation <= warnTol) return { quality: 'WARNING', deviation };
  return { quality: 'CRITICAL', deviation };
}

/**
 * scoreJoint
 * ==========
 * Maps a joint's deviation from its optimal range to a 0-100 proximity score.
 *
 *  deviation = 0          → 100  (perfectly inside optimal range)
 *  deviation = warnTol    →  70  (just at the warning/critical boundary)
 *  deviation = warnTol + critTol → 30  (just beyond the critical boundary)
 *  deviation >> critTol   →   0  (deeply out of range)
 *
 * @param {number} deviation  - how far the angle is outside the optimal range (0 if inside)
 * @param {number} warnTol    - tolerance before WARNING→CRITICAL transition
 * @param {number} critTol    - additional tolerance beyond warning before score hits ~30
 * @returns {number} score 0-100
 */
export function scoreJoint(deviation, warnTol, critTol) {
  if (deviation <= 0) return 100;
  if (warnTol == null || critTol == null) return 100;  // no benchmark — skip
  if (deviation <= warnTol) {
    // Warning zone: linearly 100 → 70
    return 100 - (deviation / warnTol) * 30;
  }
  const beyondWarn = deviation - warnTol;
  if (beyondWarn <= critTol) {
    // Critical zone: linearly 70 → 30
    return 70 - (beyondWarn / critTol) * 40;
  }
  // Beyond critical: penalise further, floor at 0
  return Math.max(0, 30 - (beyondWarn - critTol) * 2);
}

function getLandmarkCoords(landmarks, name) {
  const idx = LANDMARK_INDEX[name];
  if (idx === undefined || idx >= landmarks.length) return null;
  const lm = landmarks[idx];
  return [lm.x, lm.y];
}

// Front-camera: standard joint angles (tagged source:'FRONT')

export function computeJointAngles(landmarks, shotType = 'COVER_DRIVE', dbBenchmarks = null) {
  const benchmarkMap = (dbBenchmarks && Object.keys(dbBenchmarks).length > 0)
    ? dbBenchmarks : (INLINE_BENCHMARKS[shotType] ?? {});

  const results = [];
  for (const [jointName, lmA, lmB, lmC] of JOINT_DEFINITIONS) {
    const coordsA = getLandmarkCoords(landmarks, lmA);
    const coordsB = getLandmarkCoords(landmarks, lmB);
    const coordsC = getLandmarkCoords(landmarks, lmC);
    if (!coordsA || !coordsB || !coordsC) continue;

    const angle = calculateJointAngle(coordsA, coordsB, coordsC);
    let quality = 'UNCLASSIFIED', deviation = 0, optMin = null, optMax = null, wTol = null, cTol = null;
    const bench = benchmarkMap[jointName];
    if (bench) {
      const [oMin, oMax, wt, ct] = bench;
      optMin = oMin; optMax = oMax; wTol = wt; cTol = ct;
      ({ quality, deviation } = classifyAngleQuality(angle, oMin, oMax, wt, ct));
    }
    results.push({
      jointName, landmarkA: lmA, landmarkB: lmB, landmarkC: lmC,
      angleDegrees: Math.round(angle * 100) / 100,
      quality, deviation: Math.round(deviation * 100) / 100,
      optimalMin: optMin, optimalMax: optMax,
      warnTol: wTol, critTol: cTol,
      source: 'FRONT',
    });
  }
  return results;
}

/**
 * computeJointAnglesForPhase
 * ===========================
 * Like computeJointAngles but only computes joints that belong to `phase`.
 * Used by analyzeCompletedShot to produce phase-filtered metrics.
 */
export function computeJointAnglesForPhase(landmarks, phase, shotType = 'COVER_DRIVE', dbBenchmarks = null) {
  const benchmarkMap = (dbBenchmarks && Object.keys(dbBenchmarks).length > 0)
    ? dbBenchmarks : (INLINE_BENCHMARKS[shotType] ?? {});
  const allowedJoints = PHASE_JOINTS[phase] ?? new Set();

  const results = [];
  for (const [jointName, lmA, lmB, lmC] of JOINT_DEFINITIONS) {
    if (!allowedJoints.has(jointName)) continue;
    const coordsA = getLandmarkCoords(landmarks, lmA);
    const coordsB = getLandmarkCoords(landmarks, lmB);
    const coordsC = getLandmarkCoords(landmarks, lmC);
    if (!coordsA || !coordsB || !coordsC) continue;

    const angle = calculateJointAngle(coordsA, coordsB, coordsC);
    let quality = 'UNCLASSIFIED', deviation = 0, optMin = null, optMax = null;
    const bench = benchmarkMap[jointName];
    if (bench) {
      const [oMin, oMax, wTol, cTol] = bench;
      optMin = oMin; optMax = oMax;
      ({ quality, deviation } = classifyAngleQuality(angle, oMin, oMax, wTol, cTol));
    }
    results.push({
      jointName, landmarkA: lmA, landmarkB: lmB, landmarkC: lmC,
      angleDegrees: Math.round(angle * 100) / 100,
      quality, deviation: Math.round(deviation * 100) / 100,
      optimalMin: optMin, optimalMax: optMax,
      source: 'FRONT',
    });
  }
  return results;
}

/**
 * computeSideViewMetrics
 * ========================
 * Extracts ALL metrics only visible from the side camera (90 degrees to batsman).
 * Covers two categories:
 *
 *   A) FOOTWORK (stride / weight transfer) — impossible from front cam
 *      STRIDE_LENGTH, WEIGHT_TRANSFER, BACK_FOOT_SHIFT
 *
 *   B) FRONT-CAM BLIND SPOTS — geometry the front cam cannot measure
 *      HEAD_POSITION    : nose forward over ball line (head over ball check)
 *      LEAD_ELBOW_TUCK  : batting-arm elbow depth (chicken-wing vs tucked)
 *      FRONT_KNEE_DRIVE : how far front knee drives forward over toes
 *      BACK_KNEE_DEPTH  : how far back knee pushes forward over toes
 *      HIP_CROUCH       : how deep the batsman crouches
 *      BODY_LEAN        : torso forward lean angle
 *
 * All linear metrics are normalised by hip-height then scaled x180 to sit
 * on the existing 0-180 range bar without any display code changes.
 *
 * @param {Array}   landmarks
 * @param {string}  shotType
 * @param {string}  [handedness='RHB']     'RHB' | 'LHB'
 * @param {boolean} [flipSideCam=false]    reverse front/back if phone on other side
 * @param {Object}  [dbBenchmarks=null]
 * @returns JointAngleResult[] tagged source:'SIDE'
 */
export function computeSideViewMetrics(
  landmarks, shotType = 'COVER_DRIVE', handedness = 'RHB', flipSideCam = false, dbBenchmarks = null
) {
  if (!landmarks || landmarks.length < 33) return [];

  const benchmarkMap = (dbBenchmarks && Object.keys(dbBenchmarks).length > 0)
    ? dbBenchmarks : (INLINE_BENCHMARKS[shotType] ?? {});

  const lm = (name) => {
    const idx = LANDMARK_INDEX[name]; return idx !== undefined ? landmarks[idx] : null;
  };

  // Collect key landmarks
  const nose = lm('NOSE');
  const lShoulder = lm('LEFT_SHOULDER'), rShoulder = lm('RIGHT_SHOULDER');
  const lElbow = lm('LEFT_ELBOW'), rElbow = lm('RIGHT_ELBOW');
  const lHip = lm('LEFT_HIP'), rHip = lm('RIGHT_HIP');
  const lKnee = lm('LEFT_KNEE'), rKnee = lm('RIGHT_KNEE');
  const lAnkle = lm('LEFT_ANKLE'), rAnkle = lm('RIGHT_ANKLE');

  if (!lShoulder || !rShoulder || !lHip || !rHip || !lAnkle || !rAnkle || !lKnee || !rKnee) return [];

  // Visibility guard — skip if lower-body landmarks are unreliable
  const minVis = 0.40;
  if ((lAnkle.visibility ?? 1) < minVis || (rAnkle.visibility ?? 1) < minVis ||
    (lHip.visibility ?? 1) < minVis || (rHip.visibility ?? 1) < minVis) return [];

  // ── Determine front / back side ─────────────────────────────────────────────
  // Side view: higher x = closer to bowler = front.
  // RHB: front leg = left leg. LHB: front leg = right leg. flipSideCam reverses x.
  const leftHigherX = lAnkle.x > rAnkle.x;
  let frontIsLeft = handedness === 'RHB';
  if (flipSideCam) frontIsLeft = !frontIsLeft;

  const frontAnkle = frontIsLeft ? (leftHigherX ? lAnkle : rAnkle) : (leftHigherX ? rAnkle : lAnkle);
  const backAnkle = frontIsLeft ? (leftHigherX ? rAnkle : lAnkle) : (leftHigherX ? lAnkle : rAnkle);
  const frontKnee = frontIsLeft ? (leftHigherX ? lKnee : rKnee) : (leftHigherX ? rKnee : lKnee);
  const backKnee = frontIsLeft ? (leftHigherX ? rKnee : lKnee) : (leftHigherX ? lKnee : rKnee);

  // Lead elbow = front-arm elbow (the batting arm closest to the bowler)
  const leadElbow = frontIsLeft ? (leftHigherX ? lElbow : rElbow) : (leftHigherX ? rElbow : lElbow);
  const leadShoulder = frontIsLeft ? (leftHigherX ? lShoulder : rShoulder) : (leftHigherX ? rShoulder : lShoulder);

  // Reference measurements
  const hipMidX = (lHip.x + rHip.x) / 2;
  const hipMidY = (lHip.y + rHip.y) / 2;
  const ankleMidY = (lAnkle.y + rAnkle.y) / 2;
  const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
  const shoulderMidY = (lShoulder.y + rShoulder.y) / 2;

  // hipHeight: vertical distance hip→ankle (image y increases downward)
  const hipHeight = Math.max(ankleMidY - hipMidY, 0.05);
  // fullBodyHeight: shoulder→ankle
  const fullHeight = Math.max(ankleMidY - shoulderMidY, 0.10);
  const footSpan = Math.abs(frontAnkle.x - backAnkle.x);

  const results = [];
  const makeEntry = (jointName, rawValue) => {
    const value = Math.max(0, Math.min(180, Math.round(rawValue * 100) / 100));
    let quality = 'UNCLASSIFIED', deviation = 0, optMin = null, optMax = null;
    const bench = benchmarkMap[jointName];
    if (bench) {
      const [oMin, oMax, wTol, cTol] = bench;
      optMin = oMin; optMax = oMax;
      ({ quality, deviation } = classifyAngleQuality(value, oMin, oMax, wTol, cTol));
    }
    return {
      jointName, landmarkA: null, landmarkB: null, landmarkC: null,
      angleDegrees: value, quality,
      deviation: Math.round(deviation * 100) / 100,
      optimalMin: optMin, optimalMax: optMax,
      source: 'SIDE',
    };
  };

  // ── A. FOOTWORK ─────────────────────────────────────────────────────────────

  if (FRONT_FOOT_SHOTS.has(shotType)) {
    // Stride length: separation between feet normalised by hip-height
    results.push(makeEntry('STRIDE_LENGTH', (footSpan / hipHeight) * 180));
    // Weight transfer: how far hip midpoint is over the front foot
    if (footSpan > 0.01) {
      const fwdOffset = Math.abs(hipMidX - backAnkle.x) / footSpan;
      results.push(makeEntry('WEIGHT_TRANSFER', Math.min(fwdOffset, 1) * 180));
    }
  }

  if (BACK_FOOT_SHOTS.has(shotType)) {
    // Back-foot shift: how far back ankle pulls behind hip midpoint
    results.push(makeEntry('BACK_FOOT_SHIFT', (Math.abs(backAnkle.x - hipMidX) / hipHeight) * 180));
  }

  // ── B. FRONT-CAM BLIND SPOTS ────────────────────────────────────────────────

  // HEAD_POSITION — how far forward the head is over the ball line
  // 0 = head above back foot, 180 = head above front foot
  if (nose && (nose.visibility ?? 1) >= minVis && footSpan > 0.01) {
    const headOffset = Math.abs(nose.x - backAnkle.x) / footSpan;
    results.push(makeEntry('HEAD_POSITION', Math.min(headOffset, 1) * 180));
  }

  // LEAD_ELBOW_TUCK — elbow tucked vs chicken-wing
  // Measures how far the lead elbow is behind (away from bowler) the lead shoulder.
  // Lower = elbow tucked tight (good); higher = elbow flares backward (chicken wing).
  if (leadElbow && leadShoulder && (leadElbow.visibility ?? 1) >= minVis) {
    // In side view, "behind shoulder" = closer to back foot direction (lower x if frontIsLeft&&leftHigherX)
    // We measure: shoulderX - elbowX if player faces right (front = higher x).
    // If elbow is tucked forward, elbowX >= shoulderX → value is 0 or negative → clamped to 0.
    // If chicken wing, elbowX < shoulderX → shoulderX - elbowX is positive.
    const tuckRatio = (leadShoulder.x - leadElbow.x) / hipHeight;
    // Front-facing: higher x = toward bowler. Chicken wing pushes elbow AWAY from bowler = lower x.
    // If flipSideCam, signs reverse — use signed difference and take positive part.
    const tuck = Math.max(0, flipSideCam ? -tuckRatio : tuckRatio);
    results.push(makeEntry('LEAD_ELBOW_TUCK', tuck * 180));
  }

  // FRONT_KNEE_DRIVE — how far front knee pushes forward over the toes (front-foot shots)
  if (FRONT_FOOT_SHOTS.has(shotType)) {
    // front = higher x in normal orientation
    const driveSign = (frontIsLeft === leftHigherX) ? 1 : -1;
    const kneeOverToe = driveSign * (frontKnee.x - frontAnkle.x) / hipHeight;
    results.push(makeEntry('FRONT_KNEE_DRIVE', Math.max(0, kneeOverToe) * 180));
  }

  // BACK_KNEE_DEPTH — how far back knee pushes forward over back toes (back-foot shots)
  if (BACK_FOOT_SHOTS.has(shotType)) {
    const backSign = (frontIsLeft === leftHigherX) ? 1 : -1;
    const backKneeOver = backSign * (backKnee.x - backAnkle.x) / hipHeight;
    results.push(makeEntry('BACK_KNEE_DEPTH', Math.max(0, backKneeOver) * 180));
  }

  // HIP_CROUCH — how deep the batsman crouches
  // hipHeight/fullHeight: higher ratio = less crouch (more upright); lower = deeper crouch
  // We invert so higher value = more upright (easier to display as "Crouch depth")
  const crouchIndex = (hipHeight / fullHeight) * 180;
  results.push(makeEntry('HIP_CROUCH', crouchIndex));

  // BODY_LEAN — torso forward tilt angle from vertical (all shots)
  const dx = shoulderMidX - hipMidX, dy = shoulderMidY - hipMidY;
  const leanDeg = Math.abs((Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI);
  results.push(makeEntry('BODY_LEAN', leanDeg));

  return results;
}

/**
 * computeSideViewMetricsForPhase
 * ================================
 * Like computeSideViewMetrics but filtered to metrics that belong to `phase`.
 */
export function computeSideViewMetricsForPhase(
  landmarks, phase, shotType = 'COVER_DRIVE', handedness = 'RHB', flipSideCam = false, dbBenchmarks = null
) {
  const all = computeSideViewMetrics(landmarks, shotType, handedness, flipSideCam, dbBenchmarks);
  const allowed = PHASE_SIDE_METRICS[phase] ?? new Set();
  return all.filter(m => allowed.has(m.jointName));
}

// ── Frame velocity helpers ─────────────────────────────────────────────────────

/**
 * Compute per-frame wrist speed (normalised landmark units per millisecond).
 * frameBuffer: Array of { landmarks, timestampMs }
 * Returns Array<number> of the same length (first frame = 0).
 */
export function computeFrameVelocities(frameBuffer) {
  const velocities = [0];
  for (let i = 1; i < frameBuffer.length; i++) {
    const prev = frameBuffer[i - 1];
    const curr = frameBuffer[i];
    const dt = Math.max(curr.timestampMs - prev.timestampMs, 1);

    const LW = LANDMARK_INDEX.LEFT_WRIST;
    const RW = LANDMARK_INDEX.RIGHT_WRIST;

    const lPrev = prev.landmarks?.[LW], lCurr = curr.landmarks?.[LW];
    const rPrev = prev.landmarks?.[RW], rCurr = curr.landmarks?.[RW];

    const lSpeed = (lPrev && lCurr)
      ? Math.sqrt((lCurr.x - lPrev.x) ** 2 + (lCurr.y - lPrev.y) ** 2) / dt
      : 0;
    const rSpeed = (rPrev && rCurr)
      ? Math.sqrt((rCurr.x - rPrev.x) ** 2 + (rCurr.y - rPrev.y) ** 2) / dt
      : 0;

    let speed = 0;
    if (lSpeed > 0 && rSpeed > 0) speed = (lSpeed + rSpeed) / 2;
    else if (lSpeed > 0) speed = lSpeed;
    else if (rSpeed > 0) speed = rSpeed;

    // Fallback to elbows if wrists are not detected or stationary
    if (speed === 0) {
      const LE = LANDMARK_INDEX.LEFT_ELBOW;
      const RE = LANDMARK_INDEX.RIGHT_ELBOW;
      const lePrev = prev.landmarks?.[LE], leCurr = curr.landmarks?.[LE];
      const rePrev = prev.landmarks?.[RE], reCurr = curr.landmarks?.[RE];
      const leSpeed = (lePrev && leCurr)
        ? Math.sqrt((leCurr.x - lePrev.x) ** 2 + (leCurr.y - lePrev.y) ** 2) / dt
        : 0;
      const reSpeed = (rePrev && reCurr)
        ? Math.sqrt((reCurr.x - rePrev.x) ** 2 + (reCurr.y - rePrev.y) ** 2) / dt
        : 0;
      if (leSpeed > 0 && reSpeed > 0) speed = (leSpeed + reSpeed) / 2;
      else if (leSpeed > 0) speed = leSpeed;
      else if (reSpeed > 0) speed = reSpeed;
    }

    velocities.push(speed);
  }
  return velocities;
}

/** Smooth a velocity array with a simple moving average (window = k frames). */
function smoothVelocities(velocities, k = 5) {
  const out = [];
  for (let i = 0; i < velocities.length; i++) {
    const start = Math.max(0, i - Math.floor(k / 2));
    const end = Math.min(velocities.length, start + k);
    const slice = velocities.slice(start, end);
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

/**
 * analyzeCompletedShot
 * =====================
 * Given the full rolling frame buffer for a completed shot, segments it into
 * 3 phases using the wrist velocity profile and computes per-phase metrics.
 *
 * Phase segmentation:
 *   STANCE        - frames before wrist velocity rises past 20% of peak
 *   STRIDE_SHOT   - frames from velocity rise through peak (impact)
 *   FOLLOWTHROUGH - frames after velocity drops below 20% of peak again
 *
 * @param {Array}   frameBuffer  - [{landmarks, timestampMs}]
 * @param {string}  shotType
 * @param {string}  [handedness='RHB']
 * @param {boolean} [flipSideCam=false]
 * @param {Object}  [dbBenchmarks=null]
 * @param {Object|boolean} [options={}] - { isFile?: boolean, forceAnalyze?: boolean }
 * @returns analysis object or null if buffer too short
 */
export function analyzeCompletedShot(
  frameBuffer,
  shotType = 'COVER_DRIVE',
  handedness = 'RHB',
  flipSideCam = false,
  dbBenchmarks = null,
  options = {}
) {
  const n = frameBuffer.length;
  if (n < 6) return null;

  const isFile = typeof options === 'boolean'
    ? options
    : Boolean(options?.isFile || options?.forceAnalyze);

  const rawVel = computeFrameVelocities(frameBuffer);
  const vel = smoothVelocities(rawVel, 5);

  // Find peak velocity frame (impact)
  let peakIdx = 0;
  for (let i = 1; i < vel.length; i++) {
    if (vel[i] > vel[peakIdx]) peakIdx = i;
  }

  // Minimum peak velocity check:
  // For uploaded video files (isFile), NEVER reject the user's footage — always produce the analysis!
  // For live webcam, filter out idle standing or bat tapping.
  const MIN_SWING_PEAK_VELOCITY = 0.0006;
  if (!isFile && vel[peakIdx] < MIN_SWING_PEAK_VELOCITY) {
    return null;
  }

  const peakVal = vel[peakIdx] || 0;
  const riseThresh = peakVal > 0 ? peakVal * 0.25 : 0;
  const fallThresh = peakVal > 0 ? peakVal * 0.25 : 0;

  let stanceEnd = peakIdx;
  for (let i = peakIdx - 1; i >= 0; i--) {
    if (vel[i] <= riseThresh) { stanceEnd = i; break; }
  }

  let followStart = peakIdx;
  for (let i = peakIdx + 1; i < n; i++) {
    if (vel[i] <= fallThresh) { followStart = i; break; }
  }
  if (followStart === peakIdx) {
    followStart = Math.min(n - 1, peakIdx + Math.max(3, Math.floor(n * 0.1)));
  }

  // Pick representative frames
  let stanceFrameIdx = 0;
  let minV = Infinity;
  const searchEnd = stanceEnd > 0 ? stanceEnd : Math.max(0, peakIdx - 1);
  for (let i = 0; i <= searchEnd; i++) {
    if (vel[i] < minV) { minV = vel[i]; stanceFrameIdx = i; }
  }

  // Determine shot frame (impact)
  let shotFrameIdx = peakIdx;
  // If peak is degenerate (at very edge), pick sensible proportional anchors
  if (shotFrameIdx <= stanceFrameIdx || shotFrameIdx >= n - 1 || shotFrameIdx <= 2) {
    stanceFrameIdx = Math.max(0, Math.floor(n * 0.15));
    shotFrameIdx = Math.max(stanceFrameIdx + 1, Math.floor(n * 0.50));
  }

  let followFrameIdx = Math.min(n - 1, Math.floor((followStart + n - 1) / 2));
  if (followFrameIdx <= shotFrameIdx) {
    followFrameIdx = Math.min(n - 1, Math.max(shotFrameIdx + 1, Math.floor(n * 0.85)));
  }

  // Bound checks
  stanceFrameIdx = Math.max(0, Math.min(n - 1, stanceFrameIdx));
  shotFrameIdx = Math.max(0, Math.min(n - 1, shotFrameIdx));
  followFrameIdx = Math.max(0, Math.min(n - 1, followFrameIdx));

  const stanceFrame = frameBuffer[stanceFrameIdx] || frameBuffer[0];
  const shotFrame = frameBuffer[shotFrameIdx] || frameBuffer[Math.floor(n / 2)];
  const followFrame = frameBuffer[followFrameIdx] || frameBuffer[n - 1];

  // Compute phase metrics — use 3D (worldLandmarks) when available, fall back to 2D
  const stanceWL = stanceFrame.worldLandmarks;
  const shotWL = shotFrame.worldLandmarks;
  const followWL = followFrame.worldLandmarks;

  const stanceMetrics = stanceWL
    ? [
      ...computeJointAngles3DForPhase(stanceWL, 'STANCE', shotType, dbBenchmarks),
      ...computeSideViewMetrics3DForPhase(stanceWL, 'STANCE', shotType, handedness, dbBenchmarks),
    ]
    : computeJointAnglesForPhase(stanceFrame.landmarks, 'STANCE', shotType, dbBenchmarks);

  const shotMetrics = shotWL
    ? [
      ...computeJointAngles3DForPhase(shotWL, 'STRIDE_SHOT', shotType, dbBenchmarks),
      ...computeSideViewMetrics3DForPhase(shotWL, 'STRIDE_SHOT', shotType, handedness, dbBenchmarks),
    ]
    : computeJointAnglesForPhase(shotFrame.landmarks, 'STRIDE_SHOT', shotType, dbBenchmarks);

  const followMetrics = followWL
    ? [
      ...computeJointAngles3DForPhase(followWL, 'FOLLOWTHROUGH', shotType, dbBenchmarks),
      ...computeSideViewMetrics3DForPhase(followWL, 'FOLLOWTHROUGH', shotType, handedness, dbBenchmarks),
    ]
    : computeJointAnglesForPhase(followFrame.landmarks, 'FOLLOWTHROUGH', shotType, dbBenchmarks);

  // Overall quality summary
  const allMetrics = [...stanceMetrics, ...shotMetrics, ...followMetrics];
  const total = allMetrics.length;
  const optimal = allMetrics.filter(m => m.quality === 'OPTIMAL').length;
  const warning = allMetrics.filter(m => m.quality === 'WARNING').length;
  const critical = allMetrics.filter(m => m.quality === 'CRITICAL').length;

  return {
    phases: {
      STANCE: stanceMetrics,
      STRIDE_SHOT: shotMetrics,
      FOLLOWTHROUGH: followMetrics,
    },
    frameIndices: { stanceFrameIdx, shotFrameIdx, followFrameIdx },
    representativeFrames: {
      stance: stanceFrame.landmarks,
      stride_shot: shotFrame.landmarks,
      followthrough: followFrame.landmarks,
    },
    overallQuality: { total, optimal, warning, critical },
    velocityProfile: vel,
    peakVelocity: vel[peakIdx],
  };
}

// Legacy alias kept for any future direct callers
export const computeStrideMetrics = computeSideViewMetrics;

// ─── 3D Math (MediaPipe worldLandmarks) ───────────────────────────────────────
//
// worldLandmarks are metric 3D coordinates with origin at hip midpoint:
//   x = positive to person's LEFT  (from their perspective)
//   y = positive UPWARD
//   z = positive toward camera
//
// Because these are true 3D metric coordinates, all angle and distance
// calculations are perspective-invariant — no second camera required.

/**
 * Calculate the angle at vertex B formed by points A-B-C in 3D space.
 * @param {number[]} a  [x, y, z]
 * @param {number[]} b  [x, y, z]  ← vertex
 * @param {number[]} c  [x, y, z]
 * @returns {number} angle in degrees
 */
export function calculateJointAngle3D(a, b, c) {
  const ba = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const bc = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const dot = ba[0] * bc[0] + ba[1] * bc[1] + ba[2] * bc[2];
  const magBA = Math.sqrt(ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2);
  const magBC = Math.sqrt(bc[0] ** 2 + bc[1] ** 2 + bc[2] ** 2);
  if (magBA === 0 || magBC === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot / (magBA * magBC)))) * 180) / Math.PI;
}

/** Extract [x, y, z] from a worldLandmarks array by landmark name. */
function getLandmarkCoords3D(worldLandmarks, name) {
  const idx = LANDMARK_INDEX[name];
  if (idx === undefined || idx >= worldLandmarks.length) return null;
  const lm = worldLandmarks[idx];
  return [lm.x, lm.y, lm.z];
}

/**
 * Compute all defined joint angles using 3D worldLandmarks.
 * Drop-in replacement for computeJointAngles — returns same shape with source:'FRONT'.
 */
export function computeJointAngles3D(worldLandmarks, shotType = 'COVER_DRIVE', dbBenchmarks = null) {
  if (!worldLandmarks || worldLandmarks.length < 33) return [];
  const benchmarkMap = (dbBenchmarks && Object.keys(dbBenchmarks).length > 0)
    ? dbBenchmarks : (INLINE_BENCHMARKS[shotType] ?? {});

  const results = [];
  for (const [jointName, lmA, lmB, lmC] of JOINT_DEFINITIONS) {
    const coordsA = getLandmarkCoords3D(worldLandmarks, lmA);
    const coordsB = getLandmarkCoords3D(worldLandmarks, lmB);
    const coordsC = getLandmarkCoords3D(worldLandmarks, lmC);
    if (!coordsA || !coordsB || !coordsC) continue;

    const angle = calculateJointAngle3D(coordsA, coordsB, coordsC);
    let quality = 'UNCLASSIFIED', deviation = 0, optMin = null, optMax = null;
    const bench = benchmarkMap[jointName];
    if (bench) {
      const [oMin, oMax, wTol, cTol] = bench;
      optMin = oMin; optMax = oMax;
      ({ quality, deviation } = classifyAngleQuality(angle, oMin, oMax, wTol, cTol));
    }
    results.push({
      jointName, landmarkA: lmA, landmarkB: lmB, landmarkC: lmC,
      angleDegrees: Math.round(angle * 100) / 100,
      quality, deviation: Math.round(deviation * 100) / 100,
      optimalMin: optMin, optimalMax: optMax,
      source: 'FRONT',
    });
  }
  return results;
}

/**
 * Like computeJointAngles3D but filtered to joints that belong to `phase`.
 */
export function computeJointAngles3DForPhase(worldLandmarks, phase, shotType = 'COVER_DRIVE', dbBenchmarks = null) {
  if (!worldLandmarks || worldLandmarks.length < 33) return [];
  const benchmarkMap = (dbBenchmarks && Object.keys(dbBenchmarks).length > 0)
    ? dbBenchmarks : (INLINE_BENCHMARKS[shotType] ?? {});
  const allowedJoints = PHASE_JOINTS[phase] ?? new Set();

  const results = [];
  for (const [jointName, lmA, lmB, lmC] of JOINT_DEFINITIONS) {
    if (!allowedJoints.has(jointName)) continue;
    const coordsA = getLandmarkCoords3D(worldLandmarks, lmA);
    const coordsB = getLandmarkCoords3D(worldLandmarks, lmB);
    const coordsC = getLandmarkCoords3D(worldLandmarks, lmC);
    if (!coordsA || !coordsB || !coordsC) continue;

    const angle = calculateJointAngle3D(coordsA, coordsB, coordsC);
    let quality = 'UNCLASSIFIED', deviation = 0, optMin = null, optMax = null, wTol = null, cTol = null;
    const bench = benchmarkMap[jointName];
    if (bench) {
      const [oMin, oMax, wt, ct] = bench;
      optMin = oMin; optMax = oMax; wTol = wt; cTol = ct;
      ({ quality, deviation } = classifyAngleQuality(angle, oMin, oMax, wt, ct));
    }
    results.push({
      jointName, landmarkA: lmA, landmarkB: lmB, landmarkC: lmC,
      angleDegrees: Math.round(angle * 100) / 100,
      quality, deviation: Math.round(deviation * 100) / 100,
      optimalMin: optMin, optimalMax: optMax,
      warnTol: wTol, critTol: cTol,
      source: 'FRONT',
    });
  }
  return results;
}

/**
 * computeSideViewMetrics3D
 * =========================
 * Computes all side-view metrics (stride, weight transfer, elbow tuck,
 * knee drive, hip crouch, body lean) using 3D worldLandmarks from a
 * SINGLE camera — no second device needed.
 *
 * Because worldLandmarks are in metric 3D space, stride/depth calculations
 * work from any camera angle. The stride vector is derived from the known
 * handedness (RHB: left=front, LHB: right=front) rather than visual heuristics.
 *
 * @param {Array}  worldLandmarks  - MediaPipe worldLandmarks array
 * @param {string} shotType
 * @param {string} [handedness='RHB']  'RHB' | 'LHB'
 * @param {Object} [dbBenchmarks=null]
 * @returns JointAngleResult[] tagged source:'SIDE'
 */
export function computeSideViewMetrics3D(
  worldLandmarks, shotType = 'COVER_DRIVE', handedness = 'RHB', dbBenchmarks = null
) {
  if (!worldLandmarks || worldLandmarks.length < 33) return [];

  const benchmarkMap = (dbBenchmarks && Object.keys(dbBenchmarks).length > 0)
    ? dbBenchmarks : (INLINE_BENCHMARKS[shotType] ?? {});

  const wlm = (name) => {
    const idx = LANDMARK_INDEX[name];
    return idx !== undefined ? worldLandmarks[idx] : null;
  };

  const lShoulder = wlm('LEFT_SHOULDER'), rShoulder = wlm('RIGHT_SHOULDER');
  const lElbow = wlm('LEFT_ELBOW'), rElbow = wlm('RIGHT_ELBOW');
  const lHip = wlm('LEFT_HIP'), rHip = wlm('RIGHT_HIP');
  const lKnee = wlm('LEFT_KNEE'), rKnee = wlm('RIGHT_KNEE');
  const lAnkle = wlm('LEFT_ANKLE'), rAnkle = wlm('RIGHT_ANKLE');
  const nose = wlm('NOSE');

  if (!lShoulder || !rShoulder || !lHip || !rHip || !lAnkle || !rAnkle || !lKnee || !rKnee) return [];

  // ── Assign front / back from handedness ──────────────────────────────────
  // RHB: left foot is front (toward bowler). LHB: right foot is front.
  const frontIsLeft = handedness === 'RHB';
  const frontAnkle = frontIsLeft ? lAnkle : rAnkle;
  const backAnkle = frontIsLeft ? rAnkle : lAnkle;
  const frontKnee = frontIsLeft ? lKnee : rKnee;
  const backKnee = frontIsLeft ? rKnee : lKnee;
  const leadElbow = frontIsLeft ? lElbow : rElbow;
  const leadShoulder = frontIsLeft ? lShoulder : rShoulder;

  // ── Reference measurements (metric) ──────────────────────────────────────
  const hipMid = {
    x: (lHip.x + rHip.x) / 2,
    y: (lHip.y + rHip.y) / 2,
    z: (lHip.z + rHip.z) / 2,
  };
  const ankleMid = {
    x: (lAnkle.x + rAnkle.x) / 2,
    y: (lAnkle.y + rAnkle.y) / 2,
    z: (lAnkle.z + rAnkle.z) / 2,
  };
  const shoulderMid = {
    x: (lShoulder.x + rShoulder.x) / 2,
    y: (lShoulder.y + rShoulder.y) / 2,
    z: (lShoulder.z + rShoulder.z) / 2,
  };

  // Hip height: vertical (Y-axis) distance from hips to ankle midpoint
  const hipHeight3D = Math.max(Math.abs(hipMid.y - ankleMid.y), 0.05);   // metres
  const fullHeight3D = Math.max(Math.abs(shoulderMid.y - ankleMid.y), 0.10);

  // ── Stride vector (horizontal plane, front → back) ──────────────────────
  const strideVecX = frontAnkle.x - backAnkle.x;
  const strideVecZ = frontAnkle.z - backAnkle.z;
  const strideDist3D = Math.sqrt(strideVecX ** 2 + strideVecZ ** 2);
  const unitX = strideDist3D > 0.01 ? strideVecX / strideDist3D : 0;
  const unitZ = strideDist3D > 0.01 ? strideVecZ / strideDist3D : 1;

  const results = [];
  const makeEntry3D = (jointName, rawValue) => {
    const value = Math.max(0, Math.min(180, Math.round(rawValue * 100) / 100));
    let quality = 'UNCLASSIFIED', deviation = 0, optMin = null, optMax = null, wTol = null, cTol = null;
    const bench = benchmarkMap[jointName];
    if (bench) {
      const [oMin, oMax, wt, ct] = bench;
      optMin = oMin; optMax = oMax; wTol = wt; cTol = ct;
      ({ quality, deviation } = classifyAngleQuality(value, oMin, oMax, wt, ct));
    }
    return {
      jointName, landmarkA: null, landmarkB: null, landmarkC: null,
      angleDegrees: value, quality,
      deviation: Math.round(deviation * 100) / 100,
      optimalMin: optMin, optimalMax: optMax,
      warnTol: wTol, critTol: cTol,
      source: 'SIDE',
    };
  };

  // ── A. FOOTWORK ───────────────────────────────────────────────────────────
  if (FRONT_FOOT_SHOTS.has(shotType)) {
    // Stride length normalised to hip height (same scale as 2D version)
    results.push(makeEntry3D('STRIDE_LENGTH', (strideDist3D / hipHeight3D) * 180));

    // Weight transfer: projection of hip midpoint onto front-foot axis
    if (strideDist3D > 0.01) {
      const hvX = hipMid.x - backAnkle.x;
      const hvZ = hipMid.z - backAnkle.z;
      const transfer = (hvX * unitX + hvZ * unitZ) / strideDist3D;
      results.push(makeEntry3D('WEIGHT_TRANSFER', Math.max(0, Math.min(1, transfer)) * 180));
    }
  }

  if (BACK_FOOT_SHOTS.has(shotType)) {
    // Back-foot shift: how far back ankle pulls behind hip along stride axis
    if (strideDist3D > 0.01) {
      const bvX = hipMid.x - backAnkle.x;
      const bvZ = hipMid.z - backAnkle.z;
      const proj = bvX * unitX + bvZ * unitZ;   // positive = hip is ahead of back ankle
      const shift = Math.max(0, -proj);           // negative proj = back ankle behind hip
      results.push(makeEntry3D('BACK_FOOT_SHIFT', (shift / hipHeight3D) * 180));
    }
  }

  // ── B. FRONT-CAM BLIND SPOTS ──────────────────────────────────────────────

  // HEAD_POSITION — how far head is along the foot-to-foot axis (0=above back, 180=above front)
  if (nose && strideDist3D > 0.01) {
    const nvX = nose.x - backAnkle.x;
    const nvZ = nose.z - backAnkle.z;
    const headProj = (nvX * unitX + nvZ * unitZ) / strideDist3D;
    results.push(makeEntry3D('HEAD_POSITION', Math.max(0, Math.min(1, headProj)) * 180));
  }

  // LEAD_ELBOW_TUCK — depth of lead elbow behind lead shoulder (away from bowler)
  if (leadElbow && leadShoulder) {
    const tuckX = leadElbow.x - leadShoulder.x;
    const tuckZ = leadElbow.z - leadShoulder.z;
    // Project onto negative stride direction (away from bowler = chicken wing)
    const tuck = Math.max(0, -(tuckX * unitX + tuckZ * unitZ)) / hipHeight3D;
    results.push(makeEntry3D('LEAD_ELBOW_TUCK', tuck * 180));
  }

  // FRONT_KNEE_DRIVE — how far front knee pushes forward over front toes
  if (FRONT_FOOT_SHOTS.has(shotType)) {
    const kneeX = frontKnee.x - frontAnkle.x;
    const kneeZ = frontKnee.z - frontAnkle.z;
    const drive = Math.max(0, kneeX * unitX + kneeZ * unitZ) / hipHeight3D;
    results.push(makeEntry3D('FRONT_KNEE_DRIVE', drive * 180));
  }

  // BACK_KNEE_DEPTH — how far back knee pushes forward over back toes
  if (BACK_FOOT_SHOTS.has(shotType)) {
    const bkX = backKnee.x - backAnkle.x;
    const bkZ = backKnee.z - backAnkle.z;
    const bkDrive = Math.max(0, bkX * unitX + bkZ * unitZ) / hipHeight3D;
    results.push(makeEntry3D('BACK_KNEE_DEPTH', bkDrive * 180));
  }

  // HIP_CROUCH — vertical hip height as proportion of full body height
  results.push(makeEntry3D('HIP_CROUCH', (hipHeight3D / fullHeight3D) * 180));

  // BODY_LEAN — torso angle from vertical (Y-axis)
  const tX = shoulderMid.x - hipMid.x;
  const tY = shoulderMid.y - hipMid.y;
  const tZ = shoulderMid.z - hipMid.z;
  const tMag = Math.sqrt(tX ** 2 + tY ** 2 + tZ ** 2);
  if (tMag > 0) {
    // Angle from vertical: cos(angle) = |tY| / |torso|
    const leanDeg = (Math.acos(Math.min(1, Math.abs(tY) / tMag)) * 180) / Math.PI;
    results.push(makeEntry3D('BODY_LEAN', leanDeg));
  }

  return results;
}

/**
 * Like computeSideViewMetrics3D but filtered to metrics that belong to `phase`.
 */
export function computeSideViewMetrics3DForPhase(
  worldLandmarks, phase, shotType = 'COVER_DRIVE', handedness = 'RHB', dbBenchmarks = null
) {
  const all = computeSideViewMetrics3D(worldLandmarks, shotType, handedness, dbBenchmarks);
  const allowed = PHASE_SIDE_METRICS[phase] ?? new Set();
  return all.filter(m => allowed.has(m.jointName));
}

// ─── Best-frame Video Analysis ────────────────────────────────────────────────

/**
 * computeVideoAnalysis
 * =====================
 * Simplified replacement for the 3-phase analyzeCompletedShot.
 *
 * Strategy:
 *   1. Scan every frame in the buffer.
 *   2. Score each frame by the average visibility of 10 key landmarks
 *      (shoulders, elbows, hips, knees, ankles).
 *   3. Pick the single highest-scoring frame — the clearest, most
 *      unoccluded pose in the video — as the representative frame.
 *   4. Compute all joint angles + 3D side metrics from that frame.
 *
 * This works for any video (standing, batting, fielding) without needing
 * a detectable wrist-velocity swing peak.
 *
 * @param {Array}  frameBuffer  - [{landmarks, worldLandmarks, timestampMs}]
 * @param {string} shotType
 * @param {string} [handedness='RHB']
 * @param {Object} [dbBenchmarks=null]
 * @returns {{ bestFrameLandmarks, bestFrameWorldLandmarks, jointAngles, overallQuality, bestFrameScore }} | null
 */
export function computeVideoAnalysis(
  frameBuffer,
  shotType = 'COVER_DRIVE',
  handedness = 'RHB',
  dbBenchmarks = null
) {
  if (!frameBuffer || frameBuffer.length === 0) return null;

  // Key landmark indices used for visibility scoring
  const KEY_INDICES = [
    LANDMARK_INDEX.LEFT_SHOULDER, LANDMARK_INDEX.RIGHT_SHOULDER,
    LANDMARK_INDEX.LEFT_ELBOW, LANDMARK_INDEX.RIGHT_ELBOW,
    LANDMARK_INDEX.LEFT_HIP, LANDMARK_INDEX.RIGHT_HIP,
    LANDMARK_INDEX.LEFT_KNEE, LANDMARK_INDEX.RIGHT_KNEE,
    LANDMARK_INDEX.LEFT_ANKLE, LANDMARK_INDEX.RIGHT_ANKLE,
  ];

  let bestFrame = null;
  let bestScore = -1;

  for (const frame of frameBuffer) {
    const lms = frame.landmarks;
    if (!lms || lms.length < 33) continue;

    const score = KEY_INDICES.reduce((sum, idx) => {
      return sum + (lms[idx]?.visibility ?? 0);
    }, 0) / KEY_INDICES.length;

    if (score > bestScore) {
      bestScore = score;
      bestFrame = frame;
    }
  }

  if (!bestFrame) return null;

  const worldLMs = bestFrame.worldLandmarks;

  // Compute all joint angles (3D if worldLandmarks available, 2D otherwise)
  let frontAngles, sideMetrics;
  try {
    frontAngles = worldLMs && worldLMs.length >= 33
      ? computeJointAngles3D(worldLMs, shotType, dbBenchmarks)
      : computeJointAngles(bestFrame.landmarks, shotType, dbBenchmarks);
    sideMetrics = worldLMs && worldLMs.length >= 33
      ? computeSideViewMetrics3D(worldLMs, shotType, handedness, dbBenchmarks)
      : [];
  } catch {
    frontAngles = computeJointAngles(bestFrame.landmarks, shotType, dbBenchmarks);
    sideMetrics = [];
  }

  const jointAngles = [...frontAngles, ...sideMetrics];

  const total = jointAngles.length;
  const optimal = jointAngles.filter(j => j.quality === 'OPTIMAL').length;
  const warning = jointAngles.filter(j => j.quality === 'WARNING').length;
  const critical = jointAngles.filter(j => j.quality === 'CRITICAL').length;

  // Proximity-based score: weighted average of how close each benchmarked joint
  // is to its optimal range. UNCLASSIFIED joints (no benchmark) are excluded.
  // Result is 0-100: 100 = all joints perfectly within range.
  const scoredJoints = jointAngles.filter(j => j.warnTol != null);
  const score = scoredJoints.length > 0
    ? Math.round(
      scoredJoints.reduce((sum, j) => sum + scoreJoint(j.deviation, j.warnTol, j.critTol), 0)
      / scoredJoints.length
    )
    : null;

  return {
    bestFrameLandmarks: bestFrame.landmarks,
    bestFrameWorldLandmarks: bestFrame.worldLandmarks ?? [],
    jointAngles,
    overallQuality: { total, optimal, warning, critical, score },
    bestFrameScore: bestScore,
  };
}
