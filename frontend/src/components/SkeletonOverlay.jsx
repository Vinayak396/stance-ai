import { useEffect, useRef, useCallback } from 'react';

/**
 * MediaPipe Pose — 33 landmark connection pairs.
 * Mirrored from mediapipe.solutions.pose.POSE_CONNECTIONS.
 */
const POSE_CONNECTIONS = [
  // Face
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  // Shoulders, arms
  [11, 12],
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  // Torso
  [11, 23], [12, 24], [23, 24],
  // Legs
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];

const QUALITY_COLOR = {
  OPTIMAL:      '#00e676',
  WARNING:      '#ffd600',
  CRITICAL:     '#ff1744',
  UNCLASSIFIED: '#90a4ae',
};

const DEFAULT_BONE_COLOR  = 'rgba(61, 142, 240, 0.85)';
const DEFAULT_JOINT_COLOR = 'rgba(61, 142, 240, 1.0)';

/**
 * SkeletonOverlay
 * ================
 * Renders the MediaPipe 33-landmark skeleton on a <canvas> that sits
 * exactly over the <video> element (both are `position:absolute; inset:0`).
 *
 * COORDINATE MAPPING — how it works:
 *   MediaPipe always sees the full, uncropped video frame and returns
 *   landmarks as (x, y) ∈ [0,1] normalised to that full frame.
 *   The CSS `object-fit: cover` rule scales the video so the SHORTER
 *   dimension fills the panel; the LONGER dimension is centred and cropped.
 *   We mirror that exact scale+offset in the canvas draw so every dot
 *   lands on the correct pixel.
 *
 *   Formula (matches browser object-fit: cover):
 *     scaleX = canvasW / srcW
 *     scaleY = canvasH / srcH
 *     scale  = max(scaleX, scaleY)          ← cover: fill by larger scale
 *     renderW = srcW * scale
 *     renderH = srcH * scale
 *     offsetX = (canvasW - renderW) / 2     ← negative = cropped
 *     offsetY = (canvasH - renderH) / 2
 *     px(lm)  = offsetX + lm.x * renderW
 *     py(lm)  = offsetY + lm.y * renderH
 *
 * Props:
 *   landmarks   {Array}            - MediaPipe landmark array [{x,y,z,visibility}, …]
 *   jointAngles {Array}            - [{landmark_b, quality, angle_degrees}, …]
 *   videoRef    {React.RefObject}  - Ref to the sibling <video> element.
 *                                    Used to read videoWidth/videoHeight live.
 *   showAngles  {boolean}          - Draw degree labels at key joints.
 */
export default function SkeletonOverlay({
  landmarks   = [],
  jointAngles = [],
  videoRef    = null,
  showAngles  = true,
}) {
  const canvasRef    = useRef(null);
  // Always-current mirrors of the latest prop values — safe to read in async
  // callbacks (ResizeObserver) without stale-closure issues.
  const landmarksRef = useRef(landmarks);
  const anglesRef    = useRef(jointAngles);
  landmarksRef.current = landmarks;
  anglesRef.current    = jointAngles;

  // ── Joint-quality colour lookup ──────────────────────────────────────────
  const buildJointColorMap = useCallback((angles) => {
    const map = new Map();
    const IDX = {
      LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
      LEFT_ELBOW:    13, RIGHT_ELBOW:    14,
      LEFT_WRIST:    15, RIGHT_WRIST:    16,
      LEFT_HIP:      23, RIGHT_HIP:      24,
      LEFT_KNEE:     25, RIGHT_KNEE:     26,
      LEFT_ANKLE:    27, RIGHT_ANKLE:    28,
    };
    angles.forEach((ja) => {
      const color    = QUALITY_COLOR[ja.quality] || QUALITY_COLOR.UNCLASSIFIED;
      const vidxIdx  = IDX[ja.landmark_b];
      if (vidxIdx !== undefined) map.set(vidxIdx, { color, ...ja });
    });
    return map;
  }, []);

  // ── Core draw ────────────────────────────────────────────────────────────
  const draw = useCallback((lms, angles) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const cw  = canvas.width;   // kept = CSS rendered size by ResizeObserver
    const ch  = canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    if (!lms || lms.length === 0) return;

    // ── Compute cover-mode render rect ──────────────────────────────────────
    // Read the source dimensions LIVE from the video element every frame.
    // This guarantees we always have the real videoWidth/videoHeight even if
    // the camera changed resolution or the component just mounted.
    const video = videoRef?.current;
    const srcW  = (video?.videoWidth  > 0 ? video.videoWidth  : 640);
    const srcH  = (video?.videoHeight > 0 ? video.videoHeight : 480);

    // object-fit: cover  →  scale = max(cw/srcW, ch/srcH)
    const scale   = Math.max(cw / srcW, ch / srcH);
    const renderW = srcW * scale;
    const renderH = srcH * scale;
    const offsetX = (cw - renderW) / 2;   // negative when source is wider → cropped
    const offsetY = (ch - renderH) / 2;

    // Landmark normalized [0,1] → canvas pixel
    const px = (lm) => offsetX + lm.x * renderW;
    const py = (lm) => offsetY + lm.y * renderH;

    const jointColorMap = buildJointColorMap(angles);

    // ── Bones ─────────────────────────────────────────────────────────────
    ctx.lineWidth = 2.5;
    ctx.lineCap   = 'round';

    POSE_CONNECTIONS.forEach(([idxA, idxB]) => {
      const lmA = lms[idxA];
      const lmB = lms[idxB];
      if (!lmA || !lmB) return;
      if ((lmA.visibility ?? 1) < 0.3 || (lmB.visibility ?? 1) < 0.3) return;

      const colorA    = jointColorMap.get(idxA)?.color;
      const colorB    = jointColorMap.get(idxB)?.color;
      const boneColor = colorA || colorB || DEFAULT_BONE_COLOR;

      ctx.strokeStyle = boneColor;
      ctx.globalAlpha = Math.min(lmA.visibility ?? 1, lmB.visibility ?? 1) * 0.9 + 0.1;
      ctx.beginPath();
      ctx.moveTo(px(lmA), py(lmA));
      ctx.lineTo(px(lmB), py(lmB));
      ctx.stroke();
    });

    // ── Joints ────────────────────────────────────────────────────────────
    ctx.globalAlpha = 1.0;

    lms.forEach((lm, idx) => {
      if (!lm || (lm.visibility ?? 1) < 0.3) return;

      const x          = px(lm);
      const y          = py(lm);
      const qData      = jointColorMap.get(idx);
      const jointColor = qData?.color || DEFAULT_JOINT_COLOR;
      const radius     = qData ? 6 : 4;

      // Glow ring
      ctx.beginPath();
      ctx.arc(x, y, radius + 3, 0, 2 * Math.PI);
      ctx.fillStyle = jointColor + '30';
      ctx.fill();

      // Filled dot
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = jointColor;
      ctx.fill();

      // White border
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    });

    // ── Angle labels ──────────────────────────────────────────────────────
    if (showAngles && angles.length > 0) {
      ctx.font         = '500 11px Inter, sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';

      const LABEL_IDX = {
        LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
        LEFT_ELBOW:    13, RIGHT_ELBOW:    14,
        LEFT_HIP:      23, RIGHT_HIP:      24,
        LEFT_KNEE:     25, RIGHT_KNEE:     26,
      };

      angles.forEach((ja) => {
        const vidxIdx = LABEL_IDX[ja.landmark_b];
        if (vidxIdx === undefined) return;
        const lm = lms[vidxIdx];
        if (!lm || (lm.visibility ?? 1) < 0.4) return;

        const x     = px(lm);
        const y     = py(lm);
        const color = QUALITY_COLOR[ja.quality] || QUALITY_COLOR.UNCLASSIFIED;
        const label = `${ja.angle_degrees?.toFixed(0)}°`;

        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = 'rgba(7, 11, 20, 0.75)';
        ctx.beginPath();
        ctx.roundRect(x - tw / 2, y - 24, tw, 16, 4);
        ctx.fill();

        ctx.fillStyle = color;
        ctx.fillText(label, x, y - 9);
      });
    }
  }, [videoRef, showAngles, buildJointColorMap]);

  // ── ResizeObserver: keep canvas px size == CSS rendered size ─────────────
  // Without this, canvas.width defaults to 300 and all coords are wrong.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: cssW, height: cssH } = entry.contentRect;
        const newW = Math.round(cssW);
        const newH = Math.round(cssH);
        if (canvas.width !== newW || canvas.height !== newH) {
          canvas.width  = newW;
          canvas.height = newH;
          draw(landmarksRef.current, anglesRef.current);
        }
      }
    });

    observer.observe(canvas);
    return () => observer.disconnect();
  // draw is stable; landmarksRef/anglesRef are always current
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw]);

  // ── Redraw on every landmark update ──────────────────────────────────────
  useEffect(() => {
    draw(landmarks, jointAngles);
  }, [landmarks, jointAngles, draw]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position:      'absolute',
        top:           0,
        left:          0,
        width:         '100%',
        height:        '100%',
        pointerEvents: 'none',
      }}
      aria-label="Skeleton overlay canvas"
    />
  );
}
