import { useEffect, useRef, useCallback } from 'react';

/**
 * MediaPipe Pose — 33 landmark connection pairs.
 * Mirrored from mediapipe.solutions.pose.POSE_CONNECTIONS.
 */
const POSE_CONNECTIONS = [
  // Face
  [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10],
  // Shoulders, arms
  [11,12],
  [11,13],[13,15],[15,17],[15,19],[15,21],[17,19],
  [12,14],[14,16],[16,18],[16,20],[16,22],[18,20],
  // Torso
  [11,23],[12,24],[23,24],
  // Legs
  [23,25],[25,27],[27,29],[29,31],[27,31],
  [24,26],[26,28],[28,30],[30,32],[28,32],
];

/**
 * Color map for joint quality classification.
 */
const QUALITY_COLOR = {
  OPTIMAL:      '#00e676',
  WARNING:      '#ffd600',
  CRITICAL:     '#ff1744',
  UNCLASSIFIED: '#90a4ae',
};

/**
 * Default skeleton color when no quality data is available.
 */
const DEFAULT_BONE_COLOR  = 'rgba(61, 142, 240, 0.75)';
const DEFAULT_JOINT_COLOR = 'rgba(61, 142, 240, 1.0)';

/**
 * SkeletonOverlay
 * ================
 * A <canvas> element that renders the MediaPipe 33-landmark skeleton
 * on top of the video feed, color-coded by joint quality.
 *
 * Props:
 *   landmarks    {Array}  - List of {index, x, y, z, visibility} objects
 *   jointAngles  {Array}  - List of {joint_name, landmark_b, quality} objects
 *   width        {number} - Canvas display width (matches video element)
 *   height       {number} - Canvas display height (matches video element)
 *   showAngles   {boolean}- Whether to draw angle degree labels
 */
export default function SkeletonOverlay({
  landmarks = [],
  jointAngles = [],
  width = 640,
  height = 480,
  showAngles = true,
  objectFit = 'contain',   // 'contain' | 'cover'
}) {
  const canvasRef = useRef(null);

  // Build a lookup: landmark_index → quality color from jointAngles
  const buildJointColorMap = useCallback((jointAngles) => {
    const map = new Map();

    // MediaPipe index by landmark name
    const LANDMARK_INDEX = {
      LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
      LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
      LEFT_WRIST: 15, RIGHT_WRIST: 16,
      LEFT_HIP: 23, RIGHT_HIP: 24,
      LEFT_KNEE: 25, RIGHT_KNEE: 26,
      LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
    };

    jointAngles.forEach((ja) => {
      const color = QUALITY_COLOR[ja.quality] || QUALITY_COLOR.UNCLASSIFIED;
      // Color the vertex landmark (landmark_b)
      const vertexIdx = LANDMARK_INDEX[ja.landmark_b];
      if (vertexIdx !== undefined) {
        map.set(vertexIdx, { color, ...ja });
      }
    });

    return map;
  }, []);

  // Draw the skeleton on the canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!landmarks || landmarks.length === 0) return;

    const jointColorMap = buildJointColorMap(jointAngles);

    // Convert normalised [0,1] coords → canvas pixel coords
    // With 'contain': the video is letterboxed inside the canvas.
    // Compute the sub-rectangle the video actually occupies.
    const cw = canvas.width;
    const ch = canvas.height;
    const videoAspect = width / height;
    const canvasAspect = cw / ch;

    let renderW, renderH, offsetX, offsetY;
    if (objectFit === 'contain') {
      if (videoAspect > canvasAspect) {
        // Pillarboxed: video is wider than canvas aspect
        renderW = cw;
        renderH = cw / videoAspect;
      } else {
        // Letterboxed: video is taller than canvas aspect
        renderH = ch;
        renderW = ch * videoAspect;
      }
      offsetX = (cw - renderW) / 2;
      offsetY = (ch - renderH) / 2;
    } else {
      // cover: video fills canvas, no offset needed for landmark mapping
      // (MediaPipe still sees the full frame even though it's clipped visually)
      renderW = cw;
      renderH = ch;
      offsetX = 0;
      offsetY = 0;
    }

    const px = (lm) => offsetX + lm.x * renderW;
    const py = (lm) => offsetY + lm.y * renderH;

    // ── Draw bones (connections) ─────────────────────────────────────────
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';

    POSE_CONNECTIONS.forEach(([idxA, idxB]) => {
      const lmA = landmarks[idxA];
      const lmB = landmarks[idxB];

      if (!lmA || !lmB) return;
      // Skip low-visibility landmarks
      if (lmA.visibility < 0.3 || lmB.visibility < 0.3) return;

      // Color the bone by the higher-severity endpoint
      const colorA = jointColorMap.get(idxA)?.color;
      const colorB = jointColorMap.get(idxB)?.color;
      const boneColor = colorA || colorB || DEFAULT_BONE_COLOR;

      ctx.strokeStyle = boneColor;
      ctx.globalAlpha = Math.min(lmA.visibility, lmB.visibility) * 0.9 + 0.1;
      ctx.beginPath();
      ctx.moveTo(px(lmA), py(lmA));
      ctx.lineTo(px(lmB), py(lmB));
      ctx.stroke();
    });

    // ── Draw joints (landmarks) ──────────────────────────────────────────
    ctx.globalAlpha = 1.0;

    landmarks.forEach((lm, idx) => {
      if (!lm || lm.visibility < 0.3) return;

      const x = px(lm);
      const y = py(lm);
      const qualityData = jointColorMap.get(idx);
      const jointColor = qualityData?.color || DEFAULT_JOINT_COLOR;
      const radius = qualityData ? 6 : 4;

      // Outer glow ring
      ctx.beginPath();
      ctx.arc(x, y, radius + 3, 0, 2 * Math.PI);
      ctx.fillStyle = jointColor + '30';
      ctx.fill();

      // Inner filled circle
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = jointColor;
      ctx.fill();

      // White border for visibility
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // ── Draw angle labels at key joints ─────────────────────────────────
    if (showAngles) {
      ctx.font = '500 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      const LABEL_LANDMARK_INDEX = {
        LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
        LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
        LEFT_HIP: 23, RIGHT_HIP: 24,
        LEFT_KNEE: 25, RIGHT_KNEE: 26,
      };

      jointAngles.forEach((ja) => {
        const vertexIdx = LABEL_LANDMARK_INDEX[ja.landmark_b];
        if (vertexIdx === undefined) return;

        const lm = landmarks[vertexIdx];
        if (!lm || lm.visibility < 0.4) return;

        const x = px(lm);
        const y = py(lm);
        const color = QUALITY_COLOR[ja.quality] || QUALITY_COLOR.UNCLASSIFIED;
        const label = `${ja.angle_degrees?.toFixed(0)}°`;

        // Pill background
        const textWidth = ctx.measureText(label).width + 10;
        ctx.fillStyle = 'rgba(7, 11, 20, 0.75)';
        ctx.beginPath();
        ctx.roundRect(x - textWidth / 2, y - 24, textWidth, 16, 4);
        ctx.fill();

        ctx.fillStyle = color;
        ctx.fillText(label, x, y - 9);
      });
    }
  }, [landmarks, jointAngles, showAngles, buildJointColorMap]);

  // Re-draw whenever landmarks or angles update
  useEffect(() => {
    draw();
  }, [draw]);

  // Update canvas dimensions when width/height props change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width  = width;
      canvas.height = height;
      draw();
    }
  }, [width, height, draw]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
      aria-label="Skeleton overlay canvas"
    />
  );
}
