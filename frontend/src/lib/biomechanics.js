/**
 * StanceAI — Biomechanics Engine (Browser)
 * ==========================================
 * JavaScript port of backend/biomechanics.py.
 * Runs entirely in the browser — no server required.
 *
 * Functions:
 *   calculateJointAngle(a, b, c) → angle in degrees
 *   classifyAngleQuality(angle, optMin, optMax, warnTol, critTol) → { quality, deviation }
 *   computeJointAngles(landmarks, shotType) → JointAngleResult[]
 */

// ─── MediaPipe landmark index map (33 keypoints) ──────────────────────────────
export const LANDMARK_INDEX = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,  LEFT_EYE: 2,  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,  RIGHT_EAR: 8,
  MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,     RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,     RIGHT_WRIST: 16,
  LEFT_PINKY: 17,     RIGHT_PINKY: 18,
  LEFT_INDEX: 19,     RIGHT_INDEX: 20,
  LEFT_THUMB: 21,     RIGHT_THUMB: 22,
  LEFT_HIP: 23,       RIGHT_HIP: 24,
  LEFT_KNEE: 25,      RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,     RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,      RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};

// ─── Joint definitions ────────────────────────────────────────────────────────
// [jointName, landmarkA, vertexB, landmarkC]
export const JOINT_DEFINITIONS = [
  ['FRONT_ELBOW',    'LEFT_SHOULDER',  'LEFT_ELBOW',    'LEFT_WRIST'   ],
  ['BACK_ELBOW',     'RIGHT_SHOULDER', 'RIGHT_ELBOW',   'RIGHT_WRIST'  ],
  ['FRONT_KNEE',     'LEFT_HIP',       'LEFT_KNEE',     'LEFT_ANKLE'   ],
  ['BACK_KNEE',      'RIGHT_HIP',      'RIGHT_KNEE',    'RIGHT_ANKLE'  ],
  ['FRONT_HIP',      'LEFT_SHOULDER',  'LEFT_HIP',      'LEFT_KNEE'    ],
  ['BACK_HIP',       'RIGHT_SHOULDER', 'RIGHT_HIP',     'RIGHT_KNEE'   ],
  ['LEFT_SHOULDER',  'LEFT_ELBOW',     'LEFT_SHOULDER', 'LEFT_HIP'     ],
  ['RIGHT_SHOULDER', 'RIGHT_ELBOW',    'RIGHT_SHOULDER','RIGHT_HIP'    ],
];

// ─── Fallback benchmarks — mirrors benchmarks.csv (used when Supabase is unavailable) ─
// Format: { JOINT_NAME: [optMin, optMax, warnTol, critTol] }
// Source: McErlain-Naylor & King 2020; ECB Level 3 2021; MCC Manual 2022;
//         Cricket Australia Guide 2023; Stretch et al. 2003; Ferdinands 2007/2013
export const INLINE_BENCHMARKS = {
  COVER_DRIVE: {
    FRONT_ELBOW:    [100, 140, 15, 30],
    FRONT_KNEE:     [130, 162, 10, 22],
    BACK_KNEE:      [118, 152, 12, 25],
    FRONT_HIP:      [152, 174, 10, 20],
    BACK_HIP:       [138, 162, 12, 25],
    LEFT_SHOULDER:  [62,  98,  15, 30],
  },
  PULL_SHOT: {
    BACK_ELBOW:     [85,  120, 15, 30],
    FRONT_ELBOW:    [88,  125, 15, 30],
    FRONT_KNEE:     [102, 140, 12, 25],
    BACK_KNEE:      [98,  132, 12, 25],
    BACK_HIP:       [122, 155, 12, 25],
  },
  FORWARD_DEFENSE: {
    FRONT_ELBOW:    [58,  100, 10, 20],
    BACK_ELBOW:     [78,  115, 12, 25],
    FRONT_KNEE:     [118, 155, 10, 20],
    BACK_KNEE:      [128, 158, 10, 20],
    FRONT_HIP:      [142, 170, 12, 25],
  },
  SWEEP_SHOT: {
    FRONT_ELBOW:    [78,  115, 15, 30],
    BACK_ELBOW:     [68,  105, 15, 30],
    FRONT_KNEE:     [78,  115, 12, 25],
    BACK_KNEE:      [52,  88,  15, 30],
    FRONT_HIP:      [112, 145, 15, 30],
  },
  CUT_SHOT: {
    BACK_ELBOW:     [68,  108, 15, 30],
    FRONT_ELBOW:    [95,  132, 15, 30],
    FRONT_KNEE:     [132, 165, 10, 22],
    BACK_KNEE:      [108, 145, 12, 25],
    BACK_HIP:       [128, 160, 12, 25],
  },
  STRAIGHT_DRIVE: {
    FRONT_ELBOW:    [110, 150, 12, 25],
    FRONT_KNEE:     [132, 165, 10, 20],
    BACK_KNEE:      [122, 155, 12, 25],
    FRONT_HIP:      [153, 175, 10, 20],
    LEFT_SHOULDER:  [52,  88,  15, 30],
  },
  HOOK_SHOT: {
    BACK_ELBOW:     [58,  98,  15, 30],
    FRONT_ELBOW:    [78,  118, 15, 30],
    FRONT_KNEE:     [98,  135, 15, 30],
    BACK_KNEE:      [92,  128, 15, 30],
  },
  ON_DRIVE: {
    FRONT_ELBOW:    [88,  128, 15, 30],
    FRONT_KNEE:     [118, 155, 12, 25],
    BACK_KNEE:      [128, 158, 12, 25],
    FRONT_HIP:      [148, 172, 10, 20],
    LEFT_SHOULDER:  [58,  95,  15, 30],
  },
  LOFTED_DRIVE: {
    FRONT_ELBOW:    [118, 155, 12, 25],
    FRONT_KNEE:     [128, 160, 12, 25],
    BACK_KNEE:      [118, 150, 15, 30],
    LEFT_SHOULDER:  [42,  78,  15, 30],
  },
  FLICK_SHOT: {
    FRONT_ELBOW:    [72,  108, 15, 30],
    FRONT_KNEE:     [112, 148, 15, 30],
    FRONT_HIP:      [138, 165, 15, 30],
  },
  DEFENSIVE_LEAVE: {
    FRONT_ELBOW:    [65,  105, 12, 22],
    FRONT_KNEE:     [125, 162, 10, 20],
  },
};



// ─── Core Math ────────────────────────────────────────────────────────────────

/**
 * Calculate the angle (in degrees) at vertex B formed by points A–B–C.
 * Mirrors Python: calculate_joint_angle(a, b, c)
 *
 * @param {[number, number]} a - Point A [x, y]
 * @param {[number, number]} b - Vertex B [x, y]
 * @param {[number, number]} c - Point C [x, y]
 * @returns {number} Angle in degrees (0–180)
 */
export function calculateJointAngle(a, b, c) {
  const ba = [a[0] - b[0], a[1] - b[1]];
  const bc = [c[0] - b[0], c[1] - b[1]];

  const dot      = ba[0] * bc[0] + ba[1] * bc[1];
  const magBA    = Math.sqrt(ba[0] ** 2 + ba[1] ** 2);
  const magBC    = Math.sqrt(bc[0] ** 2 + bc[1] ** 2);

  if (magBA === 0 || magBC === 0) return 0;

  const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return (Math.acos(cosAngle) * 180) / Math.PI;
}


/**
 * Classify an observed joint angle against benchmark ranges.
 *
 * @param {number} angle        - Observed angle in degrees
 * @param {number} optMin       - Optimal range minimum
 * @param {number} optMax       - Optimal range maximum
 * @param {number} warnTol      - Warning tolerance (degrees beyond optimal)
 * @param {number} critTol      - Critical tolerance (degrees beyond optimal)
 * @returns {{ quality: string, deviation: number }}
 *   quality: 'OPTIMAL' | 'WARNING' | 'CRITICAL'
 */
export function classifyAngleQuality(angle, optMin, optMax, warnTol, critTol) {
  if (angle >= optMin && angle <= optMax) {
    return { quality: 'OPTIMAL', deviation: 0 };
  }

  const deviation = angle < optMin
    ? optMin - angle
    : angle - optMax;

  if (deviation <= warnTol) {
    return { quality: 'WARNING', deviation };
  }
  return { quality: 'CRITICAL', deviation };
}


// ─── High-level pipeline ──────────────────────────────────────────────────────

/**
 * Get [x, y] for a named landmark from a MediaPipe landmarks array.
 * MediaPipe tasks-vision returns objects with { x, y, z, visibility }.
 *
 * @param {Array} landmarks - Array of landmark objects from PoseLandmarker
 * @param {string} name     - Landmark name (e.g. 'LEFT_ELBOW')
 * @returns {[number, number] | null}
 */
function getLandmarkCoords(landmarks, name) {
  const idx = LANDMARK_INDEX[name];
  if (idx === undefined || idx >= landmarks.length) return null;
  const lm = landmarks[idx];
  return [lm.x, lm.y];
}


/**
 * Compute joint angles for all JOINT_DEFINITIONS and classify against benchmarks.
 *
 * @param {Array}  landmarks  - MediaPipe PoseLandmarker landmark array (33 items)
 * @param {string} shotType   - e.g. 'COVER_DRIVE'
 * @param {Object} [dbBenchmarks] - Optional benchmark map from Supabase (overrides inline)
 * @returns {Array<{
 *   jointName: string,
 *   landmarkA: string, landmarkB: string, landmarkC: string,
 *   angleDegrees: number,
 *   quality: string,
 *   deviation: number,
 *   optimalMin: number|null,
 *   optimalMax: number|null,
 * }>}
 */
export function computeJointAngles(landmarks, shotType = 'COVER_DRIVE', dbBenchmarks = null) {
  const benchmarkMap = dbBenchmarks ?? INLINE_BENCHMARKS[shotType] ?? {};
  const results = [];

  for (const [jointName, lmA, lmB, lmC] of JOINT_DEFINITIONS) {
    const coordsA = getLandmarkCoords(landmarks, lmA);
    const coordsB = getLandmarkCoords(landmarks, lmB);
    const coordsC = getLandmarkCoords(landmarks, lmC);

    if (!coordsA || !coordsB || !coordsC) continue;

    const angle = calculateJointAngle(coordsA, coordsB, coordsC);

    let quality   = 'UNCLASSIFIED';
    let deviation = 0;
    let optMin    = null;
    let optMax    = null;

    const bench = benchmarkMap[jointName];
    if (bench) {
      const [oMin, oMax, wTol, cTol] = bench;
      optMin = oMin;
      optMax = oMax;
      ({ quality, deviation } = classifyAngleQuality(angle, oMin, oMax, wTol, cTol));
    }

    results.push({
      jointName,
      landmarkA:    lmA,
      landmarkB:    lmB,
      landmarkC:    lmC,
      angleDegrees: Math.round(angle * 100) / 100,
      quality,
      deviation:    Math.round(deviation * 100) / 100,
      optimalMin:   optMin,
      optimalMax:   optMax,
    });
  }

  return results;
}
