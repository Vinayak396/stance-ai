/**
 * StanceAI - Biomechanics Engine (Browser)
 * Runs entirely in the browser - no server required.
 *
 * computeJointAngles    - front camera: standard joint angles
 * computeSideViewMetrics - side camera: ALL side-only insights:
 *     Stride / footwork  : STRIDE_LENGTH, WEIGHT_TRANSFER, BACK_FOOT_SHIFT
 *     Front-cam blindspots: HEAD_POSITION, LEAD_ELBOW_TUCK,
 *                           FRONT_KNEE_DRIVE, BACK_KNEE_DEPTH, HIP_CROUCH
 *     Always             : BODY_LEAN
 */

export const LANDMARK_INDEX = {
  NOSE:0, LEFT_EYE_INNER:1, LEFT_EYE:2, LEFT_EYE_OUTER:3,
  RIGHT_EYE_INNER:4, RIGHT_EYE:5, RIGHT_EYE_OUTER:6,
  LEFT_EAR:7, RIGHT_EAR:8, MOUTH_LEFT:9, MOUTH_RIGHT:10,
  LEFT_SHOULDER:11, RIGHT_SHOULDER:12, LEFT_ELBOW:13, RIGHT_ELBOW:14,
  LEFT_WRIST:15, RIGHT_WRIST:16, LEFT_PINKY:17, RIGHT_PINKY:18,
  LEFT_INDEX:19, RIGHT_INDEX:20, LEFT_THUMB:21, RIGHT_THUMB:22,
  LEFT_HIP:23, RIGHT_HIP:24, LEFT_KNEE:25, RIGHT_KNEE:26,
  LEFT_ANKLE:27, RIGHT_ANKLE:28, LEFT_HEEL:29, RIGHT_HEEL:30,
  LEFT_FOOT_INDEX:31, RIGHT_FOOT_INDEX:32,
};

export const FRONT_FOOT_SHOTS = new Set([
  'COVER_DRIVE','FORWARD_DEFENSE','STRAIGHT_DRIVE',
  'ON_DRIVE','LOFTED_DRIVE','FLICK_SHOT','DEFENSIVE_LEAVE',
]);

export const BACK_FOOT_SHOTS = new Set([
  'PULL_SHOT','CUT_SHOT','HOOK_SHOT','SWEEP_SHOT',
]);

export const JOINT_DEFINITIONS = [
  ['FRONT_ELBOW',   'LEFT_SHOULDER', 'LEFT_ELBOW',    'LEFT_WRIST'   ],
  ['BACK_ELBOW',    'RIGHT_SHOULDER','RIGHT_ELBOW',   'RIGHT_WRIST'  ],
  ['FRONT_KNEE',    'LEFT_HIP',      'LEFT_KNEE',     'LEFT_ANKLE'   ],
  ['BACK_KNEE',     'RIGHT_HIP',     'RIGHT_KNEE',    'RIGHT_ANKLE'  ],
  ['FRONT_HIP',     'LEFT_SHOULDER', 'LEFT_HIP',      'LEFT_KNEE'    ],
  ['BACK_HIP',      'RIGHT_SHOULDER','RIGHT_HIP',     'RIGHT_KNEE'   ],
  ['LEFT_SHOULDER', 'LEFT_ELBOW',    'LEFT_SHOULDER', 'LEFT_HIP'     ],
  ['RIGHT_SHOULDER','RIGHT_ELBOW',   'RIGHT_SHOULDER','RIGHT_HIP'    ],
];

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
 *                      how far back knee pushes forward over toes (back-foot shots)
 *   HIP_CROUCH       = hipHeight / fullBodyHeight * 180
 *                      how deep the batsman crouches (higher = taller/more upright)
 *   BODY_LEAN        = torso angle from vertical (degrees, all shots)
 */
export const INLINE_BENCHMARKS = {
  COVER_DRIVE: {
    // Front-cam joints
    FRONT_ELBOW:[100,140,15,30], BACK_ELBOW:[90,130,15,30],
    FRONT_KNEE:[130,162,10,22], BACK_KNEE:[118,152,12,25],
    FRONT_HIP:[152,174,10,20], BACK_HIP:[138,162,12,25],
    LEFT_SHOULDER:[62,98,15,30], RIGHT_SHOULDER:[55,92,15,30],
    // Side-cam footwork
    STRIDE_LENGTH:[81,135,22,45], WEIGHT_TRANSFER:[108,144,18,36],
    // Side-cam blind spots
    HEAD_POSITION:[81,126,18,36],    // head 45-70% over foot span
    LEAD_ELBOW_TUCK:[0,27,12,25],    // tucked; <15% hip-height behind shoulder
    FRONT_KNEE_DRIVE:[18,54,15,30],  // moderate drive over toe
    HIP_CROUCH:[90,126,15,30],       // 50-70% hip-height ratio
    BODY_LEAN:[5,20,8,16],
  },
  PULL_SHOT: {
    BACK_ELBOW:[85,120,15,30], FRONT_ELBOW:[88,125,15,30],
    FRONT_KNEE:[102,140,12,25], BACK_KNEE:[98,132,12,25], BACK_HIP:[122,155,12,25],
    BACK_FOOT_SHIFT:[36,90,18,36],
    HEAD_POSITION:[54,99,18,36],     // head stays back
    LEAD_ELBOW_TUCK:[0,36,12,25],
    BACK_KNEE_DEPTH:[18,54,15,30],   // back knee over toe for pull
    HIP_CROUCH:[72,108,15,30],       // lower crouch for pull
    BODY_LEAN:[0,12,8,16],
  },
  FORWARD_DEFENSE: {
    FRONT_ELBOW:[58,100,10,20], BACK_ELBOW:[78,115,12,25],
    FRONT_KNEE:[118,155,10,20], BACK_KNEE:[128,158,10,20], FRONT_HIP:[142,170,12,25],
    STRIDE_LENGTH:[63,117,20,40], WEIGHT_TRANSFER:[90,135,18,36],
    HEAD_POSITION:[90,135,15,30],    // head well over ball for defense
    LEAD_ELBOW_TUCK:[0,27,12,25],
    FRONT_KNEE_DRIVE:[18,54,15,30],
    HIP_CROUCH:[90,126,15,30],
    BODY_LEAN:[8,22,8,16],
  },
  SWEEP_SHOT: {
    FRONT_ELBOW:[78,115,15,30], BACK_ELBOW:[68,105,15,30],
    FRONT_KNEE:[78,115,12,25], BACK_KNEE:[52,88,15,30], FRONT_HIP:[112,145,15,30],
    BACK_FOOT_SHIFT:[18,72,18,36],
    HEAD_POSITION:[72,117,18,36],
    LEAD_ELBOW_TUCK:[0,36,15,30],
    BACK_KNEE_DEPTH:[27,72,15,30],
    HIP_CROUCH:[54,90,18,36],        // very low for sweep
    BODY_LEAN:[10,28,10,20],
  },
  CUT_SHOT: {
    BACK_ELBOW:[68,108,15,30], FRONT_ELBOW:[95,132,15,30],
    FRONT_KNEE:[132,165,10,22], BACK_KNEE:[108,145,12,25], BACK_HIP:[128,160,12,25],
    BACK_FOOT_SHIFT:[27,81,18,36],
    HEAD_POSITION:[54,99,18,36],
    LEAD_ELBOW_TUCK:[0,36,15,30],
    BACK_KNEE_DEPTH:[18,54,15,30],
    HIP_CROUCH:[81,117,15,30],
    BODY_LEAN:[0,15,8,16],
  },
  STRAIGHT_DRIVE: {
    FRONT_ELBOW:[110,150,12,25], FRONT_KNEE:[132,165,10,20],
    BACK_KNEE:[122,155,12,25], FRONT_HIP:[153,175,10,20], LEFT_SHOULDER:[52,88,15,30],
    STRIDE_LENGTH:[81,135,22,45], WEIGHT_TRANSFER:[108,153,18,36],
    HEAD_POSITION:[90,135,15,30],
    LEAD_ELBOW_TUCK:[0,27,12,25],
    FRONT_KNEE_DRIVE:[18,54,15,30],
    HIP_CROUCH:[90,126,15,30],
    BODY_LEAN:[5,18,8,16],
  },
  HOOK_SHOT: {
    BACK_ELBOW:[58,98,15,30], FRONT_ELBOW:[78,118,15,30],
    FRONT_KNEE:[98,135,15,30], BACK_KNEE:[92,128,15,30],
    BACK_FOOT_SHIFT:[36,90,18,36],
    HEAD_POSITION:[45,90,18,36],
    LEAD_ELBOW_TUCK:[0,36,15,30],
    BACK_KNEE_DEPTH:[18,54,15,30],
    HIP_CROUCH:[72,108,15,30],
    BODY_LEAN:[0,10,8,16],
  },
  ON_DRIVE: {
    FRONT_ELBOW:[88,128,15,30], FRONT_KNEE:[118,155,12,25],
    BACK_KNEE:[128,158,12,25], FRONT_HIP:[148,172,10,20], LEFT_SHOULDER:[58,95,15,30],
    STRIDE_LENGTH:[72,126,22,45], WEIGHT_TRANSFER:[99,144,18,36],
    HEAD_POSITION:[81,126,18,36],
    LEAD_ELBOW_TUCK:[0,27,12,25],
    FRONT_KNEE_DRIVE:[18,54,15,30],
    HIP_CROUCH:[90,126,15,30],
    BODY_LEAN:[5,20,8,16],
  },
  LOFTED_DRIVE: {
    FRONT_ELBOW:[118,155,12,25], FRONT_KNEE:[128,160,12,25],
    BACK_KNEE:[118,150,15,30], LEFT_SHOULDER:[42,78,15,30],
    STRIDE_LENGTH:[72,126,22,45], WEIGHT_TRANSFER:[99,144,18,36],
    HEAD_POSITION:[72,117,18,36],
    LEAD_ELBOW_TUCK:[0,36,15,30],
    FRONT_KNEE_DRIVE:[27,63,15,30],  // more drive for lofted
    HIP_CROUCH:[81,117,15,30],
    BODY_LEAN:[8,25,8,16],
  },
  FLICK_SHOT: {
    FRONT_ELBOW:[72,108,15,30], FRONT_KNEE:[112,148,15,30], FRONT_HIP:[138,165,15,30],
    STRIDE_LENGTH:[54,108,22,45], WEIGHT_TRANSFER:[90,135,18,36],
    HEAD_POSITION:[72,117,18,36],
    LEAD_ELBOW_TUCK:[0,27,12,25],
    FRONT_KNEE_DRIVE:[18,54,15,30],
    HIP_CROUCH:[90,126,15,30],
    BODY_LEAN:[5,18,8,16],
  },
  DEFENSIVE_LEAVE: {
    FRONT_ELBOW:[65,105,12,22], FRONT_KNEE:[125,162,10,20],
    STRIDE_LENGTH:[36,90,20,40], WEIGHT_TRANSFER:[81,126,18,36],
    HEAD_POSITION:[63,108,18,36],
    LEAD_ELBOW_TUCK:[0,27,12,25],
    FRONT_KNEE_DRIVE:[9,45,15,30],
    HIP_CROUCH:[99,135,15,30],       // tall stance for leave
    BODY_LEAN:[3,15,8,16],
  },
};

// Core math

export function calculateJointAngle(a, b, c) {
  const ba = [a[0]-b[0], a[1]-b[1]];
  const bc = [c[0]-b[0], c[1]-b[1]];
  const dot = ba[0]*bc[0]+ba[1]*bc[1];
  const magBA = Math.sqrt(ba[0]**2+ba[1]**2);
  const magBC = Math.sqrt(bc[0]**2+bc[1]**2);
  if (magBA===0||magBC===0) return 0;
  return (Math.acos(Math.max(-1,Math.min(1,dot/(magBA*magBC))))*180)/Math.PI;
}

export function classifyAngleQuality(angle,optMin,optMax,warnTol,critTol) {
  if (angle>=optMin&&angle<=optMax) return {quality:'OPTIMAL',deviation:0};
  const deviation = angle<optMin ? optMin-angle : angle-optMax;
  if (deviation<=warnTol) return {quality:'WARNING',deviation};
  return {quality:'CRITICAL',deviation};
}

function getLandmarkCoords(landmarks, name) {
  const idx = LANDMARK_INDEX[name];
  if (idx===undefined||idx>=landmarks.length) return null;
  const lm = landmarks[idx];
  return [lm.x, lm.y];
}

// Front-camera: standard joint angles (tagged source:'FRONT')

export function computeJointAngles(landmarks, shotType='COVER_DRIVE', dbBenchmarks=null) {
  const benchmarkMap = (dbBenchmarks&&Object.keys(dbBenchmarks).length>0)
    ? dbBenchmarks : (INLINE_BENCHMARKS[shotType]??{});

  const results = [];
  for (const [jointName,lmA,lmB,lmC] of JOINT_DEFINITIONS) {
    const coordsA = getLandmarkCoords(landmarks,lmA);
    const coordsB = getLandmarkCoords(landmarks,lmB);
    const coordsC = getLandmarkCoords(landmarks,lmC);
    if (!coordsA||!coordsB||!coordsC) continue;

    const angle = calculateJointAngle(coordsA,coordsB,coordsC);
    let quality='UNCLASSIFIED', deviation=0, optMin=null, optMax=null;
    const bench = benchmarkMap[jointName];
    if (bench) {
      const [oMin,oMax,wTol,cTol]=bench;
      optMin=oMin; optMax=oMax;
      ({quality,deviation}=classifyAngleQuality(angle,oMin,oMax,wTol,cTol));
    }
    results.push({
      jointName, landmarkA:lmA, landmarkB:lmB, landmarkC:lmC,
      angleDegrees:Math.round(angle*100)/100,
      quality, deviation:Math.round(deviation*100)/100,
      optimalMin:optMin, optimalMax:optMax,
      source:'FRONT',
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
  landmarks, shotType='COVER_DRIVE', handedness='RHB', flipSideCam=false, dbBenchmarks=null
) {
  if (!landmarks||landmarks.length<33) return [];

  const benchmarkMap = (dbBenchmarks&&Object.keys(dbBenchmarks).length>0)
    ? dbBenchmarks : (INLINE_BENCHMARKS[shotType]??{});

  const lm = (name) => {
    const idx=LANDMARK_INDEX[name]; return idx!==undefined?landmarks[idx]:null;
  };

  // Collect key landmarks
  const nose      = lm('NOSE');
  const lShoulder = lm('LEFT_SHOULDER'), rShoulder = lm('RIGHT_SHOULDER');
  const lElbow    = lm('LEFT_ELBOW'),    rElbow    = lm('RIGHT_ELBOW');
  const lHip      = lm('LEFT_HIP'),      rHip      = lm('RIGHT_HIP');
  const lKnee     = lm('LEFT_KNEE'),     rKnee     = lm('RIGHT_KNEE');
  const lAnkle    = lm('LEFT_ANKLE'),    rAnkle    = lm('RIGHT_ANKLE');

  if (!lShoulder||!rShoulder||!lHip||!rHip||!lAnkle||!rAnkle||!lKnee||!rKnee) return [];

  // Visibility guard — skip if lower-body landmarks are unreliable
  const minVis=0.40;
  if ((lAnkle.visibility??1)<minVis||(rAnkle.visibility??1)<minVis||
      (lHip.visibility??1)<minVis||(rHip.visibility??1)<minVis) return [];

  // ── Determine front / back side ─────────────────────────────────────────────
  // Side view: higher x = closer to bowler = front.
  // RHB: front leg = left leg. LHB: front leg = right leg. flipSideCam reverses x.
  const leftHigherX  = lAnkle.x > rAnkle.x;
  let frontIsLeft    = handedness==='RHB';
  if (flipSideCam) frontIsLeft = !frontIsLeft;

  const frontAnkle = frontIsLeft ? (leftHigherX?lAnkle:rAnkle) : (leftHigherX?rAnkle:lAnkle);
  const backAnkle  = frontIsLeft ? (leftHigherX?rAnkle:lAnkle) : (leftHigherX?lAnkle:rAnkle);
  const frontKnee  = frontIsLeft ? (leftHigherX?lKnee:rKnee)   : (leftHigherX?rKnee:lKnee);
  const backKnee   = frontIsLeft ? (leftHigherX?rKnee:lKnee)   : (leftHigherX?lKnee:rKnee);

  // Lead elbow = front-arm elbow (the batting arm closest to the bowler)
  const leadElbow    = frontIsLeft ? (leftHigherX?lElbow:rElbow) : (leftHigherX?rElbow:lElbow);
  const leadShoulder = frontIsLeft ? (leftHigherX?lShoulder:rShoulder) : (leftHigherX?rShoulder:lShoulder);

  // Reference measurements
  const hipMidX      = (lHip.x+rHip.x)/2;
  const hipMidY      = (lHip.y+rHip.y)/2;
  const ankleMidY    = (lAnkle.y+rAnkle.y)/2;
  const shoulderMidX = (lShoulder.x+rShoulder.x)/2;
  const shoulderMidY = (lShoulder.y+rShoulder.y)/2;

  // hipHeight: vertical distance hip→ankle (image y increases downward)
  const hipHeight    = Math.max(ankleMidY - hipMidY, 0.05);
  // fullBodyHeight: shoulder→ankle
  const fullHeight   = Math.max(ankleMidY - shoulderMidY, 0.10);
  const footSpan     = Math.abs(frontAnkle.x - backAnkle.x);

  const results = [];
  const makeEntry = (jointName, rawValue) => {
    const value = Math.max(0,Math.min(180,Math.round(rawValue*100)/100));
    let quality='UNCLASSIFIED', deviation=0, optMin=null, optMax=null;
    const bench = benchmarkMap[jointName];
    if (bench) {
      const [oMin,oMax,wTol,cTol]=bench;
      optMin=oMin; optMax=oMax;
      ({quality,deviation}=classifyAngleQuality(value,oMin,oMax,wTol,cTol));
    }
    return {
      jointName, landmarkA:null, landmarkB:null, landmarkC:null,
      angleDegrees:value, quality,
      deviation:Math.round(deviation*100)/100,
      optimalMin:optMin, optimalMax:optMax,
      source:'SIDE',
    };
  };

  // ── A. FOOTWORK ─────────────────────────────────────────────────────────────

  if (FRONT_FOOT_SHOTS.has(shotType)) {
    // Stride length: separation between feet normalised by hip-height
    results.push(makeEntry('STRIDE_LENGTH', (footSpan/hipHeight)*180));
    // Weight transfer: how far hip midpoint is over the front foot
    if (footSpan>0.01) {
      const fwdOffset = Math.abs(hipMidX-backAnkle.x)/footSpan;
      results.push(makeEntry('WEIGHT_TRANSFER', Math.min(fwdOffset,1)*180));
    }
  }

  if (BACK_FOOT_SHOTS.has(shotType)) {
    // Back-foot shift: how far back ankle pulls behind hip midpoint
    results.push(makeEntry('BACK_FOOT_SHIFT', (Math.abs(backAnkle.x-hipMidX)/hipHeight)*180));
  }

  // ── B. FRONT-CAM BLIND SPOTS ────────────────────────────────────────────────

  // HEAD_POSITION — how far forward the head is over the ball line
  // 0 = head above back foot, 180 = head above front foot
  if (nose && (nose.visibility??1)>=minVis && footSpan>0.01) {
    const headOffset = Math.abs(nose.x-backAnkle.x)/footSpan;
    results.push(makeEntry('HEAD_POSITION', Math.min(headOffset,1)*180));
  }

  // LEAD_ELBOW_TUCK — elbow tucked vs chicken-wing
  // Measures how far the lead elbow is behind (away from bowler) the lead shoulder.
  // Lower = elbow tucked tight (good); higher = elbow flares backward (chicken wing).
  if (leadElbow && leadShoulder && (leadElbow.visibility??1)>=minVis) {
    // In side view, "behind shoulder" = closer to back foot direction (lower x if frontIsLeft&&leftHigherX)
    // We measure: shoulderX - elbowX if player faces right (front = higher x).
    // If elbow is tucked forward, elbowX >= shoulderX → value is 0 or negative → clamped to 0.
    // If chicken wing, elbowX < shoulderX → shoulderX - elbowX is positive.
    const tuckRatio = (leadShoulder.x - leadElbow.x) / hipHeight;
    // Front-facing: higher x = toward bowler. Chicken wing pushes elbow AWAY from bowler = lower x.
    // If flipSideCam, signs reverse — use signed difference and take positive part.
    const tuck = Math.max(0, flipSideCam ? -tuckRatio : tuckRatio);
    results.push(makeEntry('LEAD_ELBOW_TUCK', tuck*180));
  }

  // FRONT_KNEE_DRIVE — how far front knee pushes forward over the toes (front-foot shots)
  if (FRONT_FOOT_SHOTS.has(shotType)) {
    // front = higher x in normal orientation
    const driveSign = (frontIsLeft === leftHigherX) ? 1 : -1;
    const kneeOverToe = driveSign * (frontKnee.x - frontAnkle.x) / hipHeight;
    results.push(makeEntry('FRONT_KNEE_DRIVE', Math.max(0,kneeOverToe)*180));
  }

  // BACK_KNEE_DEPTH — how far back knee pushes forward over back toes (back-foot shots)
  if (BACK_FOOT_SHOTS.has(shotType)) {
    const backSign = (frontIsLeft === leftHigherX) ? 1 : -1;
    const backKneeOver = backSign * (backKnee.x - backAnkle.x) / hipHeight;
    results.push(makeEntry('BACK_KNEE_DEPTH', Math.max(0,backKneeOver)*180));
  }

  // HIP_CROUCH — how deep the batsman crouches
  // hipHeight/fullHeight: higher ratio = less crouch (more upright); lower = deeper crouch
  // We invert so higher value = more upright (easier to display as "Crouch depth")
  const crouchIndex = (hipHeight/fullHeight)*180;
  results.push(makeEntry('HIP_CROUCH', crouchIndex));

  // BODY_LEAN — torso forward tilt angle from vertical (all shots)
  const dx=shoulderMidX-hipMidX, dy=shoulderMidY-hipMidY;
  const leanDeg=Math.abs((Math.atan2(Math.abs(dx),Math.abs(dy))*180)/Math.PI);
  results.push(makeEntry('BODY_LEAN', leanDeg));

  return results;
}

// Legacy alias kept for any future direct callers
export const computeStrideMetrics = computeSideViewMetrics;
