/**
 * StanceAI — usePoseDetection Hook
 * ==================================
 * Runs MediaPipe PoseLandmarker entirely in the browser via WebAssembly.
 * No backend server required.
 *
 * The hook manages:
 *  - Loading the MediaPipe WASM model (cached after first load)
 *  - Starting / stopping the webcam stream
 *  - Running pose detection on every animation frame
 *  - Computing joint angles via biomechanics.js
 *
 * Usage:
 * ```jsx
 * const {
 *   isModelReady, isRunning, error,
 *   landmarks, jointAngles, fps,
 *   startCamera, stopCamera,
 * } = usePoseDetection({ shotType: 'COVER_DRIVE' });
 * ```
 *
 * Attach videoRef.current to a <video> element and canvasRef.current to a
 * <canvas> for skeleton drawing — the hook writes directly to both.
 */

import { useEffect, useRef, useCallback, useReducer } from 'react';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { computeJointAngles, analyzeCompletedShot } from '../lib/biomechanics.js';

// ─── MediaPipe model path (served from CDN) ────────────────────────────────
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

// ─── Shot detection thresholds ─────────────────────────────────────────────
// (normalised landmark units per millisecond)
const SHOT_START_THRESHOLD = 0.001_8;  // wrist speed that marks shot start
const SHOT_END_THRESHOLD = 0.000_6;  // wrist speed that marks shot end
const COOLDOWN_FRAMES = 18;        // consecutive low-vel frames to confirm shot ended
const MAX_BUFFER_FRAMES = 180;       // ~6 s @ 30 fps

// ─── State ─────────────────────────────────────────────────────────────────
const INITIAL_STATE = {
  isModelReady: false,
  isRunning: false,
  error: null,
  landmarks: [],      // raw MediaPipe landmark objects
  jointAngles: [],      // computed JointAngleResult[] (live frame)
  fps: 0,
  frameCount: 0,
  // 3-phase shot analysis (null until a complete shot is detected)
  shotAnalysis: null,
  // Countdown seconds remaining before auto-reset (null when no analysis)
  resetCountdown: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'MODEL_READY':
      return { ...state, isModelReady: true, error: null };
    case 'RUNNING':
      return { ...state, isRunning: true, error: null };
    case 'STOPPED':
      return { ...state, isRunning: false, landmarks: [], jointAngles: [], fps: 0 };
    case 'ERROR':
      return { ...state, error: action.payload, isRunning: false };
    case 'POSE_DATA':
      return {
        ...state,
        landmarks: action.payload.landmarks,
        jointAngles: action.payload.jointAngles,
        fps: action.payload.fps,
        frameCount: state.frameCount + 1,
      };
    // Static image result — show data but keep isRunning false
    case 'IMAGE_ANALYZED':
      return {
        ...state,
        isRunning: false,
        error: action.payload.error ?? null,
        landmarks: action.payload.landmarks ?? [],
        jointAngles: action.payload.jointAngles ?? [],
        fps: 0,
        frameCount: action.payload.landmarks?.length ? state.frameCount + 1 : state.frameCount,
      };
    case 'SHOT_ANALYZED':
      return { ...state, shotAnalysis: action.payload, resetCountdown: 5 };
    case 'COUNTDOWN_TICK':
      return {
        ...state,
        resetCountdown: state.resetCountdown !== null ? Math.max(0, state.resetCountdown - 1) : null,
      };
    case 'RESET_SHOT':
      return { ...state, shotAnalysis: null, resetCountdown: null };
    default:
      return state;
  }
}

// ─── Hook ──────────────────────────────────────────────────────────────────

/**
 * @param {object}  options
 * @param {string}  options.shotType      - Cricket shot type for angle classification
 * @param {object}  options.dbBenchmarks  - Optional benchmarks fetched from Supabase
 * @param {React.RefObject} options.videoRef  - Ref to the <video> element
 */
export function usePoseDetection({
  shotType = 'COVER_DRIVE',
  dbBenchmarks = null,
  videoRef,
} = {}) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const landmarkerRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const lastFrameTimeRef = useRef(0);
  const fpsSampleRef = useRef([]);
  const videoModeRef = useRef('WEBCAM'); // 'WEBCAM' | 'FILE'

  // ── Shot detection state machine ──────────────────────────────────────
  // IDLE: waiting for movement; ACTIVE: shot in progress; COOLING: shot done
  const shotStateRef = useRef('IDLE');   // 'IDLE'|'ACTIVE'|'COOLING'
  const frameBufferRef = useRef([]);        // rolling {landmarks,timestampMs}[]
  const cooldownFramesRef = useRef(0);         // consecutive low-velocity frames after shot
  const resetTimerRef = useRef(null);      // countdown interval id
  const countdownTickRef = useRef(null);      // 1-second interval for countdown display

  // ── Load MediaPipe model once on mount ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function loadModel() {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
        const landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate: 'GPU',    // falls back to CPU automatically
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false,
        });

        if (!cancelled) {
          landmarkerRef.current = landmarker;
          dispatch({ type: 'MODEL_READY' });
          console.log('[StanceAI] MediaPipe PoseLandmarker ready.');
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[StanceAI] Failed to load MediaPipe model:', err);
          dispatch({ type: 'ERROR', payload: 'Failed to load pose model. Check your internet connection.' });
        }
      }
    }

    loadModel();
    return () => { cancelled = true; };
  }, []);

  // ── Detection loop ─────────────────────────────────────────────────────
  const detectLoop = useCallback(() => {
    const video = videoRef?.current;
    if (!video || video.readyState < 2 || !landmarkerRef.current) {
      rafRef.current = requestAnimationFrame(detectLoop);
      return;
    }

    const nowMs = performance.now();
    const result = landmarkerRef.current.detectForVideo(video, nowMs);

    if (result.landmarks && result.landmarks.length > 0) {
      const rawLandmarks = result.landmarks[0]; // first detected person

      // FPS calculation (rolling 10-frame average)
      if (lastFrameTimeRef.current) {
        const delta = nowMs - lastFrameTimeRef.current;
        fpsSampleRef.current.push(1000 / delta);
        if (fpsSampleRef.current.length > 10) fpsSampleRef.current.shift();
      }
      lastFrameTimeRef.current = nowMs;
      const fps = Math.round(
        fpsSampleRef.current.reduce((a, b) => a + b, 0) / (fpsSampleRef.current.length || 1)
      );

      const jointAngles = computeJointAngles(rawLandmarks, shotType, dbBenchmarks);

      dispatch({
        type: 'POSE_DATA',
        payload: { landmarks: rawLandmarks, jointAngles, fps },
      });

      // ── Shot detection ─────────────────────────────────────────────────
      // Only run when not in COOLING (post-shot display) state
      if (shotStateRef.current !== 'COOLING') {
        // Append to rolling frame buffer
        frameBufferRef.current.push({ landmarks: rawLandmarks, timestampMs: nowMs });
        if (frameBufferRef.current.length > MAX_BUFFER_FRAMES) {
          frameBufferRef.current.shift();
        }

        // Compute instantaneous wrist velocity
        const buf = frameBufferRef.current;
        let wristVel = 0;
        if (buf.length >= 2) {
          const prev = buf[buf.length - 2];
          const curr = buf[buf.length - 1];
          const dt = Math.max(nowMs - prev.timestampMs, 1);
          const LW = 15; // LEFT_WRIST
          const RW = 16; // RIGHT_WRIST
          const lS = prev.landmarks[LW] && curr.landmarks[LW]
            ? Math.sqrt((curr.landmarks[LW].x - prev.landmarks[LW].x) ** 2 + (curr.landmarks[LW].y - prev.landmarks[LW].y) ** 2) / dt
            : 0;
          const rS = prev.landmarks[RW] && curr.landmarks[RW]
            ? Math.sqrt((curr.landmarks[RW].x - prev.landmarks[RW].x) ** 2 + (curr.landmarks[RW].y - prev.landmarks[RW].y) ** 2) / dt
            : 0;
          wristVel = (lS + rS) / 2;
        }

        if (shotStateRef.current === 'IDLE') {
          if (wristVel > SHOT_START_THRESHOLD) {
            shotStateRef.current = 'ACTIVE';
            cooldownFramesRef.current = 0;
          }
        } else if (shotStateRef.current === 'ACTIVE') {
          if (wristVel < SHOT_END_THRESHOLD) {
            cooldownFramesRef.current++;
            if (cooldownFramesRef.current >= COOLDOWN_FRAMES) {
              // ── Shot complete — analyse the buffer ──────────────────────
              shotStateRef.current = 'COOLING';
              const analysis = analyzeCompletedShot(
                frameBufferRef.current, shotType, 'RHB', false, dbBenchmarks
              );
              if (analysis) {
                dispatch({ type: 'SHOT_ANALYZED', payload: analysis });

                // Countdown ticker: fires every 1 s to update the displayed number
                if (countdownTickRef.current) clearInterval(countdownTickRef.current);
                countdownTickRef.current = setInterval(() => {
                  dispatch({ type: 'COUNTDOWN_TICK' });
                }, 1000);

                // Auto-reset after 5 s
                if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
                resetTimerRef.current = setTimeout(() => {
                  dispatch({ type: 'RESET_SHOT' });
                  if (countdownTickRef.current) {
                    clearInterval(countdownTickRef.current);
                    countdownTickRef.current = null;
                  }
                  shotStateRef.current = 'IDLE';
                  frameBufferRef.current = [];
                }, 5000);
              } else {
                // Analysis returned null (not enough frames) — stay IDLE
                shotStateRef.current = 'IDLE';
              }
            }
          } else {
            cooldownFramesRef.current = 0; // still moving — reset cooldown
          }
        }
      }
    }

    rafRef.current = requestAnimationFrame(detectLoop);
  }, [videoRef, shotType, dbBenchmarks]);

  // ── Start camera ───────────────────────────────────────────────────────
  /**
   * @param {string|null} deviceId - Optional specific camera device ID.
   *   When provided, opens that exact device (e.g. phone virtual webcam).
   *   When omitted, falls back to facingMode:'user' (default laptop cam).
   */
  const startCamera = useCallback(async (deviceId = null) => {
    if (state.isRunning) return;
    if (!landmarkerRef.current) {
      dispatch({ type: 'ERROR', payload: 'Pose model not loaded yet. Please wait.' });
      return;
    }

    try {
      // Let the camera stream at its native resolution — no forced 640×480.
      // Constraining width/height causes the browser to letterbox or crop
      // the stream, which is what produces the black bars.
      const videoConstraints = deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: 'user' };

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef?.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      dispatch({ type: 'RUNNING' });
      fpsSampleRef.current = [];
      lastFrameTimeRef.current = 0;
      rafRef.current = requestAnimationFrame(detectLoop);

    } catch (err) {
      console.error('[StanceAI] Camera error:', err);
      dispatch({
        type: 'ERROR',
        payload: err.name === 'NotAllowedError'
          ? 'Camera access denied. Please allow camera permissions.'
          : `Camera error: ${err.message}`,
      });
    }
  }, [state.isRunning, videoRef, detectLoop]);

  // ── Start from uploaded video file (no getUserMedia) ───────────────────
  const startFromVideoElement = useCallback(() => {
    if (state.isRunning) return;
    if (!landmarkerRef.current) {
      dispatch({ type: 'ERROR', payload: 'Pose model not loaded yet. Please wait.' });
      return;
    }
    videoModeRef.current = 'FILE';
    dispatch({ type: 'RUNNING' });
    fpsSampleRef.current = [];
    lastFrameTimeRef.current = 0;
    rafRef.current = requestAnimationFrame(detectLoop);
  }, [state.isRunning, detectLoop]);

  // ── Analyze a static image (single-shot, no RAF loop) ──────────────────
  const analyzeImage = useCallback(async (imageElement) => {
    if (!landmarkerRef.current) {
      dispatch({ type: 'ERROR', payload: 'Pose model not loaded yet. Please wait.' });
      return;
    }
    // Stop any running video loop first
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      // Switch MediaPipe to IMAGE mode for single-frame detection
      await landmarkerRef.current.setOptions({ runningMode: 'IMAGE' });
      const result = landmarkerRef.current.detect(imageElement);
      // Restore VIDEO mode for subsequent webcam / file-video use
      await landmarkerRef.current.setOptions({ runningMode: 'VIDEO' });

      if (result.landmarks && result.landmarks.length > 0) {
        const rawLandmarks = result.landmarks[0];
        const jointAngles = computeJointAngles(rawLandmarks, shotType, dbBenchmarks);
        dispatch({
          type: 'IMAGE_ANALYZED',
          payload: { landmarks: rawLandmarks, jointAngles },
        });
      } else {
        dispatch({
          type: 'IMAGE_ANALYZED',
          payload: { landmarks: [], jointAngles: [], error: 'No pose detected in image.' },
        });
      }
    } catch (err) {
      console.error('[StanceAI] Image detection error:', err);
      dispatch({ type: 'ERROR', payload: `Image analysis failed: ${err.message}` });
    }
  }, [shotType, dbBenchmarks]);

  // ── Stop camera / video ────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef?.current) {
      if (videoModeRef.current === 'WEBCAM') {
        videoRef.current.srcObject = null;
      } else {
        // For file uploads: pause video but keep src so user can see the frame
        videoRef.current.pause();
      }
    }
    videoModeRef.current = 'WEBCAM';
    dispatch({ type: 'STOPPED' });
  }, [videoRef]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      if (countdownTickRef.current) clearInterval(countdownTickRef.current);
    };
  }, []);

  return {
    ...state,
    startCamera,
    startFromVideoElement,
    analyzeImage,
    stopCamera,
  };
}
