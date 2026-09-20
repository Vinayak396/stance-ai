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
import {
  computeJointAngles,
  computeJointAngles3D,
  computeSideViewMetrics3D,
  computeVideoAnalysis,
} from '../lib/biomechanics.js';

// ─── MediaPipe model path (served from CDN) ─────────────────────────────────────────────
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
// pose_landmarker_full: higher accuracy than _lite — better with occluded / fast-motion cricket poses.
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';

// ─── Shot detection thresholds ─────────────────────────────────────────────
// (normalised landmark units per millisecond)
const SHOT_START_THRESHOLD = 0.0020;  // smoothed wrist speed to initiate downswing detection
const SHOT_END_THRESHOLD = 0.0016;    // wrist speed indicating followthrough settling
const COOLDOWN_FRAMES = 10;          // frames (~330ms @ 30fps) to confirm shot ended
const MIN_SHOT_PEAK_VEL = 0.0024;     // minimum peak velocity during stroke to qualify as real shot
const MIN_ACTIVE_FRAMES = 5;          // minimum frames in ACTIVE state (filters single-frame twitches)
const MAX_BUFFER_FRAMES = 180;        // ~6 s @ 30 fps

// ─── State ─────────────────────────────────────────────────────────────────
const INITIAL_STATE = {
  isModelReady: false,
  isRunning: false,
  error: null,
  landmarks: [],        // raw MediaPipe 2D landmark objects (for skeleton overlay)
  worldLandmarks: [],   // MediaPipe 3D world landmarks in metric coordinates
  jointAngles: [],      // merged 3D FRONT + SIDE JointAngleResult[] (live frame)
  fps: 0,
  frameCount: 0,
  // Best-frame video analysis result (null until video ends or shot detected)
  videoAnalysis: null,
  // Countdown seconds remaining before auto-reset (null when no analysis)
  resetCountdown: null,
  // Preparation countdown seconds (null when not preparing, 5..1 or 0 for "READY!")
  prepCountdown: null,
  // Detection state: 'IDLE' | 'PREPARING' | 'ACTIVE' | 'COOLING'
  shotDetectionState: 'IDLE',
};

function reducer(state, action) {
  switch (action.type) {
    case 'MODEL_READY':
      return { ...state, isModelReady: true, error: null };
    case 'RUNNING':
      return { ...state, isRunning: true, error: null };
    case 'STOPPED':
      return {
        ...state,
        isRunning: false,
        landmarks: [],
        worldLandmarks: [],
        jointAngles: [],
        fps: 0,
        prepCountdown: null,
        shotDetectionState: 'IDLE',
      };
    case 'ERROR':
      return { ...state, error: action.payload, isRunning: false, prepCountdown: null };
    case 'POSE_DATA':
      return {
        ...state,
        landmarks: action.payload.landmarks,
        worldLandmarks: action.payload.worldLandmarks ?? [],
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
        worldLandmarks: action.payload.worldLandmarks ?? [],
        jointAngles: action.payload.jointAngles ?? [],
        fps: 0,
        frameCount: action.payload.landmarks?.length ? state.frameCount + 1 : state.frameCount,
      };
    case 'PREP_COUNTDOWN':
      return {
        ...state,
        prepCountdown: action.payload,
        shotDetectionState: action.payload !== null ? 'PREPARING' : 'IDLE',
      };
    case 'SET_SHOT_DETECTION_STATE':
      return { ...state, shotDetectionState: action.payload };
    // Webcam: a genuine shot completed — best-frame result from the shot buffer
    case 'SHOT_ANALYZED':
      return {
        ...state,
        videoAnalysis: action.payload,
        landmarks: action.payload.bestFrameLandmarks ?? state.landmarks,
        worldLandmarks: action.payload.bestFrameWorldLandmarks ?? state.worldLandmarks,
        jointAngles: action.payload.jointAngles ?? state.jointAngles,
        resetCountdown: null,
        shotDetectionState: 'COOLING',
      };
    // File video: analysis complete — always freeze on best-visibility frame
    case 'FILE_ANALYZED':
      return {
        ...state,
        isRunning: false,
        videoAnalysis: action.payload,
        landmarks: action.payload.bestFrameLandmarks ?? [],
        worldLandmarks: action.payload.bestFrameWorldLandmarks ?? [],
        jointAngles: action.payload.jointAngles ?? [],
        resetCountdown: null,
        fps: 0,
        shotDetectionState: 'IDLE',
      };
    case 'FILE_DONE':
      return {
        ...state,
        isRunning: false,
        fps: 0,
        shotDetectionState: 'IDLE',
      };
    case 'RESET_SHOT':
      return { ...state, videoAnalysis: null, resetCountdown: null, shotDetectionState: 'IDLE' };
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
 * @param {string}  options.handedness    - 'RHB' | 'LHB' for 3D side-view metrics
 */
export function usePoseDetection({
  shotType = 'COVER_DRIVE',
  dbBenchmarks = null,
  videoRef,
  handedness = 'RHB',
  onFileVideoEnded = null,
} = {}) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const landmarkerRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const lastFrameTimeRef = useRef(0);
  const fpsSampleRef = useRef([]);
  const videoModeRef = useRef('WEBCAM'); // 'WEBCAM' | 'FILE'
  const onFileVideoEndedRef = useRef(onFileVideoEnded);
  onFileVideoEndedRef.current = onFileVideoEnded;

  // ── Shot detection state machine ──────────────────────────────────────
  // IDLE: waiting for movement; PREPARING: countdown to stance; ACTIVE: shot in progress; COOLING: shot done
  const shotStateRef = useRef('IDLE');   // 'IDLE'|'PREPARING'|'ACTIVE'|'COOLING'
  const frameBufferRef = useRef([]);        // rolling {landmarks,timestampMs}[]
  const savedFileBufferRef = useRef([]);    // cached frames from completed video upload for re-analysis
  const cooldownFramesRef = useRef(0);         // consecutive low-velocity frames after shot
  const smoothedWristVelRef = useRef(0);
  const peakShotVelRef = useRef(0);
  const activeFramesCountRef = useRef(0);
  const prepTimerRef = useRef(null);
  const lastVideoTimeRef = useRef(-1);
  const lastProcessedTimeMsRef = useRef(0);
  const scalingCanvasRef = useRef(null);

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
          // Warm up GPU shaders and WebGL pipelines immediately!
          // Without this warmup, the first call to detectForVideo blocks the main JS thread
          // for ~1-2 seconds while compiling shaders, causing the video to stutter and skip frames.
          try {
            const warmupCanvas = document.createElement('canvas');
            warmupCanvas.width = 256;
            warmupCanvas.height = 256;
            const ctx = warmupCanvas.getContext('2d');
            if (ctx) {
              ctx.fillStyle = '#111';
              ctx.fillRect(0, 0, 256, 256);
            }
            landmarker.detectForVideo(warmupCanvas, 1);
            console.log('[StanceAI] MediaPipe PoseLandmarker warmed up.');
          } catch (wErr) {
            console.warn('[StanceAI] Model warmup pass completed or skipped:', wErr);
          }

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

  // ── Finalize video file analysis when video reaches the end ─────────────
  const finalizeFileAnalysis = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const video = videoRef?.current;
    if (video && !video.paused) {
      video.pause();
    }

    // Prefer the current run's frame buffer; fall back to cached buffer from a prior run.
    const buf = frameBufferRef.current.length >= 1
      ? frameBufferRef.current
      : (savedFileBufferRef.current.length >= 1 ? savedFileBufferRef.current : []);

    if (buf.length >= 1) {
      savedFileBufferRef.current = [...buf];
      const result = computeVideoAnalysis(buf, shotType, handedness, dbBenchmarks);
      if (result) {
        dispatch({ type: 'FILE_ANALYZED', payload: result });
      } else {
        dispatch({ type: 'FILE_DONE' });
      }
    } else {
      dispatch({ type: 'FILE_DONE' });
    }

    if (onFileVideoEndedRef.current) {
      onFileVideoEndedRef.current();
    }
  }, [videoRef, shotType, handedness, dbBenchmarks]);

  // Automatically re-run analysis if shotType or handedness or benchmarks change for an analyzed video
  useEffect(() => {
    if (videoModeRef.current === 'FILE' && savedFileBufferRef.current.length >= 1 && !state.isRunning) {
      const result = computeVideoAnalysis(
        savedFileBufferRef.current, shotType, handedness, dbBenchmarks
      );
      if (result) {
        dispatch({ type: 'FILE_ANALYZED', payload: result });
      }
    }
  }, [shotType, handedness, dbBenchmarks, state.isRunning]);

  // ── Detection loop ─────────────────────────────────────────────────────
  const detectLoop = useCallback(() => {
    const video = videoRef?.current;
    if (!video || !landmarkerRef.current) {
      rafRef.current = requestAnimationFrame(detectLoop);
      return;
    }

    if (videoModeRef.current === 'FILE') {
      // Check if uploaded video finished
      if (video.ended || (video.duration && video.currentTime >= video.duration - 0.05)) {
        finalizeFileAnalysis();
        return;
      }

      // Avoid re-running heavy inference on duplicate frames if video has not advanced
      if (video.currentTime === lastVideoTimeRef.current) {
        rafRef.current = requestAnimationFrame(detectLoop);
        return;
      }
      lastVideoTimeRef.current = video.currentTime;
    }

    if (video.readyState < 2) {
      rafRef.current = requestAnimationFrame(detectLoop);
      return;
    }

    // Determine inference source (downscale large 1080p/4K frames to max 960px to prevent GPU bus bottlenecks)
    let inferenceSource = video;
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    const maxDim = Math.max(vw, vh);
    if (maxDim > 960) {
      if (!scalingCanvasRef.current) {
        scalingCanvasRef.current = document.createElement('canvas');
      }
      const sc = scalingCanvasRef.current;
      const factor = 960 / maxDim;
      const tw = Math.round(vw * factor);
      const th = Math.round(vh * factor);
      if (sc.width !== tw || sc.height !== th) {
        sc.width = tw;
        sc.height = th;
      }
      const sctx = sc.getContext('2d', { willReadFrequently: false });
      if (sctx) {
        sctx.drawImage(video, 0, 0, tw, th);
        inferenceSource = sc;
      }
    }

    const nowMs = performance.now();
    // ── Two separate timestamps serve two different purposes ───────────────
    // frameTimestampMs  → sent to MediaPipe detectForVideo.
    //   Must be strictly monotonically increasing across the entire lifetime of
    //   the landmarker instance (including across separate video re-analysis runs).
    //   Uses performance.now() as the floor so re-runs never go backwards.
    // bufferTimestampMs → stored in the frame buffer for velocity calculations.
    //   Must reflect actual elapsed video time so that dt = curr - prev ≈ 33ms
    //   regardless of how many times the video has been re-analysed.
    //   Uses video.currentTime for FILE mode (real video position in ms).
    let frameTimestampMs;
    let bufferTimestampMs;
    if (videoModeRef.current === 'FILE') {
      const vidMs = Math.round(video.currentTime * 1000);
      frameTimestampMs = Math.max(vidMs, (lastProcessedTimeMsRef.current || 0) + 1);
      bufferTimestampMs = vidMs; // actual video position — keeps velocity dt correct
    } else {
      frameTimestampMs = Math.max(nowMs, (lastProcessedTimeMsRef.current || 0) + 1);
      bufferTimestampMs = frameTimestampMs;
    }
    lastProcessedTimeMsRef.current = frameTimestampMs;

    let result;
    try {
      result = landmarkerRef.current.detectForVideo(inferenceSource, frameTimestampMs);
    } catch (detErr) {
      console.warn('[StanceAI] detectForVideo skipped frame:', detErr);
      rafRef.current = requestAnimationFrame(detectLoop);
      return;
    }

    if (result && result.landmarks && result.landmarks.length > 0) {
      const rawLandmarks = result.landmarks[0];        // 2D screen coords (for skeleton overlay)
      const rawWorldLMs = result.worldLandmarks?.[0] ?? null;  // 3D metric coords

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

      // Compute merged 3D joint angles (front) + 3D side-view metrics from single camera.
      // Falls back to 2D front-only if worldLandmarks are unavailable or 3D computation fails.
      let frontAngles, sideMetrics, jointAngles;
      try {
        frontAngles = rawWorldLMs
          ? computeJointAngles3D(rawWorldLMs, shotType, dbBenchmarks)
          : computeJointAngles(rawLandmarks, shotType, dbBenchmarks);
        sideMetrics = rawWorldLMs
          ? computeSideViewMetrics3D(rawWorldLMs, shotType, handedness, dbBenchmarks)
          : [];
        jointAngles = [...frontAngles, ...sideMetrics];
      } catch (calcErr) {
        console.warn('[StanceAI] 3D metric computation failed, falling back to 2D:', calcErr);
        frontAngles = computeJointAngles(rawLandmarks, shotType, dbBenchmarks);
        sideMetrics = [];
        jointAngles = frontAngles;
      }

      dispatch({
        type: 'POSE_DATA',
        payload: { landmarks: rawLandmarks, worldLandmarks: rawWorldLMs ?? [], jointAngles, fps },
      });

      // ── Shot detection ─────────────────────────────────────────────────
      // Store actual video time (bufferTimestampMs) — not the MediaPipe inference
      // timestamp — so that velocity dt = curr - prev reflects real frame intervals.
      frameBufferRef.current.push({ landmarks: rawLandmarks, worldLandmarks: rawWorldLMs, timestampMs: bufferTimestampMs });
      const maxFrames = videoModeRef.current === 'FILE' ? 1800 : MAX_BUFFER_FRAMES;
      if (frameBufferRef.current.length > maxFrames) {
        frameBufferRef.current.shift();
      }

      if (videoModeRef.current === 'WEBCAM') {
        if (shotStateRef.current === 'PREPARING') {
          // Keep buffer trimmed during countdown so walking movements don't contaminate the shot
          if (frameBufferRef.current.length > 20) {
            frameBufferRef.current.shift();
          }
          smoothedWristVelRef.current = 0;
          peakShotVelRef.current = 0;
          activeFramesCountRef.current = 0;
        } else if (shotStateRef.current !== 'COOLING') {
          // Compute smoothed wrist velocity
          const buf = frameBufferRef.current;
          let instantVel = 0;
          if (buf.length >= 2) {
            const prev = buf[buf.length - 2];
            const curr = buf[buf.length - 1];
            const dt = Math.max(nowMs - prev.timestampMs, 10);
            const LW = 15; // LEFT_WRIST
            const RW = 16; // RIGHT_WRIST
            const lS = prev.landmarks[LW] && curr.landmarks[LW]
              ? Math.sqrt((curr.landmarks[LW].x - prev.landmarks[LW].x) ** 2 + (curr.landmarks[LW].y - prev.landmarks[LW].y) ** 2) / dt
              : 0;
            const rS = prev.landmarks[RW] && curr.landmarks[RW]
              ? Math.sqrt((curr.landmarks[RW].x - prev.landmarks[RW].x) ** 2 + (curr.landmarks[RW].y - prev.landmarks[RW].y) ** 2) / dt
              : 0;
            instantVel = (lS + rS) / 2;
          }

          // Exponential moving average filter (alpha = 0.35)
          smoothedWristVelRef.current = smoothedWristVelRef.current === 0
            ? instantVel
            : smoothedWristVelRef.current * 0.65 + instantVel * 0.35;
          const wristVel = smoothedWristVelRef.current;

          if (shotStateRef.current === 'IDLE') {
            if (wristVel > SHOT_START_THRESHOLD) {
              shotStateRef.current = 'ACTIVE';
              cooldownFramesRef.current = 0;
              peakShotVelRef.current = wristVel;
              activeFramesCountRef.current = 1;
              dispatch({ type: 'SET_SHOT_DETECTION_STATE', payload: 'ACTIVE' });
            }
          } else if (shotStateRef.current === 'ACTIVE') {
            activeFramesCountRef.current += 1;
            peakShotVelRef.current = Math.max(peakShotVelRef.current, wristVel);

            if (wristVel < SHOT_END_THRESHOLD) {
              cooldownFramesRef.current++;
              if (cooldownFramesRef.current >= COOLDOWN_FRAMES) {
                // Check if this was a genuine shot or just a slow bat lift / stance pause
                const isGenuineShot = peakShotVelRef.current >= MIN_SHOT_PEAK_VEL && activeFramesCountRef.current >= MIN_ACTIVE_FRAMES;

                if (!isGenuineShot) {
                  // Not a real shot! (Slow bat lift or tap). Silently revert to IDLE.
                  shotStateRef.current = 'IDLE';
                  cooldownFramesRef.current = 0;
                  peakShotVelRef.current = 0;
                  activeFramesCountRef.current = 0;
                  if (frameBufferRef.current.length > 25) {
                    frameBufferRef.current = frameBufferRef.current.slice(-25);
                  }
                  dispatch({ type: 'SET_SHOT_DETECTION_STATE', payload: 'IDLE' });
                } else {
                  // Genuine stroke completed — find best frame and analyze!
                  shotStateRef.current = 'COOLING';
                  const result = computeVideoAnalysis(
                    frameBufferRef.current, shotType, handedness, dbBenchmarks
                  );
                  if (result) {
                    dispatch({ type: 'SHOT_ANALYZED', payload: result });
                  } else {
                    shotStateRef.current = 'IDLE';
                    cooldownFramesRef.current = 0;
                    peakShotVelRef.current = 0;
                    activeFramesCountRef.current = 0;
                    dispatch({ type: 'SET_SHOT_DETECTION_STATE', payload: 'IDLE' });
                  }
                }
              }
            } else if (wristVel >= SHOT_START_THRESHOLD) {
              // Stroke still in motion — reset cooldown
              cooldownFramesRef.current = 0;
            } else {
              // Gentle followthrough settling — decay cooldown rather than abruptly wiping it
              cooldownFramesRef.current = Math.max(0, cooldownFramesRef.current - 1);
            }

            // Safety timeout: if in active for > 4.5s (135 frames), conclude and analyze if peak was reached
            if (activeFramesCountRef.current > 135) {
              if (peakShotVelRef.current >= MIN_SHOT_PEAK_VEL) {
                shotStateRef.current = 'COOLING';
                const result = computeVideoAnalysis(
                  frameBufferRef.current, shotType, handedness, dbBenchmarks
                );
                if (result) {
                  dispatch({ type: 'SHOT_ANALYZED', payload: result });
                } else {
                  shotStateRef.current = 'IDLE';
                  cooldownFramesRef.current = 0;
                  peakShotVelRef.current = 0;
                  activeFramesCountRef.current = 0;
                  dispatch({ type: 'SET_SHOT_DETECTION_STATE', payload: 'IDLE' });
                }
              } else {
                shotStateRef.current = 'IDLE';
                cooldownFramesRef.current = 0;
                peakShotVelRef.current = 0;
                activeFramesCountRef.current = 0;
                dispatch({ type: 'SET_SHOT_DETECTION_STATE', payload: 'IDLE' });
              }
            }
          }
        }
      }
    }

    // Check again if video ended after processing
    if (videoModeRef.current === 'FILE' && (video.ended || (video.duration && video.currentTime >= video.duration - 0.05))) {
      finalizeFileAnalysis();
      return;
    }

    rafRef.current = requestAnimationFrame(detectLoop);
  }, [videoRef, shotType, dbBenchmarks, handedness, finalizeFileAnalysis]);

  // ── Preparation countdown for stance setup ──────────────────────────────
  const startPrepCountdown = useCallback((seconds = 5) => {
    const sec = typeof seconds === 'number' && !isNaN(seconds) && seconds > 0 ? Math.round(seconds) : 5;
    if (prepTimerRef.current) {
      clearInterval(prepTimerRef.current);
      prepTimerRef.current = null;
    }
    shotStateRef.current = 'PREPARING';
    cooldownFramesRef.current = 0;
    frameBufferRef.current = [];
    smoothedWristVelRef.current = 0;
    peakShotVelRef.current = 0;
    activeFramesCountRef.current = 0;

    dispatch({ type: 'PREP_COUNTDOWN', payload: sec });

    let remaining = sec;
    prepTimerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        dispatch({ type: 'PREP_COUNTDOWN', payload: remaining });
      } else if (remaining === 0) {
        // 0 displays "READY!" on screen
        dispatch({ type: 'PREP_COUNTDOWN', payload: 0 });
        shotStateRef.current = 'IDLE';
        cooldownFramesRef.current = 0;
        frameBufferRef.current = [];
        smoothedWristVelRef.current = 0;
        peakShotVelRef.current = 0;
        activeFramesCountRef.current = 0;
      } else {
        clearInterval(prepTimerRef.current);
        prepTimerRef.current = null;
        dispatch({ type: 'PREP_COUNTDOWN', payload: null });
        shotStateRef.current = 'IDLE';
        cooldownFramesRef.current = 0;
        frameBufferRef.current = [];
      }
    }, 1000);
  }, []);

  const skipPrepCountdown = useCallback(() => {
    if (prepTimerRef.current) {
      clearInterval(prepTimerRef.current);
      prepTimerRef.current = null;
    }
    dispatch({ type: 'PREP_COUNTDOWN', payload: null });
    shotStateRef.current = 'IDLE';
    cooldownFramesRef.current = 0;
    frameBufferRef.current = [];
    smoothedWristVelRef.current = 0;
    peakShotVelRef.current = 0;
    activeFramesCountRef.current = 0;
  }, []);

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
      // Give batsman 5 seconds to walk back to crease and take stance
      startPrepCountdown(5);

    } catch (err) {
      console.error('[StanceAI] Camera error:', err);
      dispatch({
        type: 'ERROR',
        payload: err.name === 'NotAllowedError'
          ? 'Camera access denied. Please allow camera permissions.'
          : `Camera error: ${err.message}`,
      });
    }
  }, [state.isRunning, videoRef, detectLoop, startPrepCountdown]);

  // ── Start from uploaded video file (no getUserMedia) ───────────────────
  const startFromVideoElement = useCallback(() => {
    if (!landmarkerRef.current) {
      dispatch({ type: 'ERROR', payload: 'Pose model not loaded yet. Please wait.' });
      return;
    }
    if (prepTimerRef.current) {
      clearInterval(prepTimerRef.current);
      prepTimerRef.current = null;
    }
    dispatch({ type: 'PREP_COUNTDOWN', payload: null });
    videoModeRef.current = 'FILE';
    frameBufferRef.current = [];
    shotStateRef.current = 'IDLE';
    cooldownFramesRef.current = 0;
    smoothedWristVelRef.current = 0;
    peakShotVelRef.current = 0;
    activeFramesCountRef.current = 0;
    lastVideoTimeRef.current = -1;
    // Use performance.now() — NOT 0 — so the new run's timestamps are always
    // strictly greater than the last timestamp from the previous run.
    // MediaPipe's detectForVideo requires monotonically increasing timestamps
    // across ALL calls to the same landmarker instance; resetting to 0 causes
    // every re-analysis frame to be silently rejected with a timestamp error.
    lastProcessedTimeMsRef.current = performance.now();

    const video = videoRef?.current;
    if (video) {
      video.loop = false;
      const handleEnded = () => {
        finalizeFileAnalysis();
      };
      video.addEventListener('ended', handleEnded, { once: true });
    }

    dispatch({ type: 'RUNNING' });
    fpsSampleRef.current = [];
    lastFrameTimeRef.current = 0;
    rafRef.current = requestAnimationFrame(detectLoop);
  }, [detectLoop, videoRef, finalizeFileAnalysis]);

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
        const rawWorldLMs = result.worldLandmarks?.[0] ?? null;
        const frontAngles = rawWorldLMs
          ? computeJointAngles3D(rawWorldLMs, shotType, dbBenchmarks)
          : computeJointAngles(rawLandmarks, shotType, dbBenchmarks);
        const sideMetrics = rawWorldLMs
          ? computeSideViewMetrics3D(rawWorldLMs, shotType, handedness, dbBenchmarks)
          : [];
        const jointAngles = [...frontAngles, ...sideMetrics];
        dispatch({
          type: 'IMAGE_ANALYZED',
          payload: { landmarks: rawLandmarks, worldLandmarks: rawWorldLMs ?? [], jointAngles },
        });
      } else {
        dispatch({
          type: 'IMAGE_ANALYZED',
          payload: { landmarks: [], worldLandmarks: [], jointAngles: [], error: 'No pose detected in image.' },
        });
      }
    } catch (err) {
      console.error('[StanceAI] Image detection error:', err);
      dispatch({ type: 'ERROR', payload: `Image analysis failed: ${err.message}` });
    }
  }, [shotType, dbBenchmarks, handedness]);

  // ── Stop camera / video ────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    if (prepTimerRef.current) {
      clearInterval(prepTimerRef.current);
      prepTimerRef.current = null;
    }
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
        dispatch({ type: 'STOPPED' });
      } else {
        // For file uploads: pause and finalize analysis
        finalizeFileAnalysis();
      }
    } else {
      dispatch({ type: 'STOPPED' });
    }
    videoModeRef.current = 'WEBCAM';
  }, [videoRef, finalizeFileAnalysis]);

  // ── Reset state to record and analyze the next shot manually ─────────────
  const startNextShot = useCallback((seconds = 5) => {
    const sec = typeof seconds === 'number' && !isNaN(seconds) && seconds > 0 ? Math.round(seconds) : 5;
    dispatch({ type: 'RESET_SHOT' });
    if (videoModeRef.current === 'WEBCAM') {
      startPrepCountdown(sec);
    } else {
      shotStateRef.current = 'IDLE';
      cooldownFramesRef.current = 0;
      frameBufferRef.current = [];
      smoothedWristVelRef.current = 0;
      peakShotVelRef.current = 0;
      activeFramesCountRef.current = 0;
    }
  }, [startPrepCountdown]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      if (prepTimerRef.current) clearInterval(prepTimerRef.current);
    };
  }, []);

  // ── Fast re-analysis without replaying the video ─────────────────────────
  // Runs computeVideoAnalysis on the SAME saved frame buffer produced by the
  // first (or last) video playthrough. Because the input is identical bytes,
  // the output (best frame, joint angles, score) is also identical every time.
  // Returns true if the buffer existed and analysis was dispatched; the caller
  // should fall back to a full video replay when this returns false.
  const reanalyzeFromBuffer = useCallback(() => {
    if (savedFileBufferRef.current.length < 1) return false;
    const result = computeVideoAnalysis(
      savedFileBufferRef.current, shotType, handedness, dbBenchmarks
    );
    if (result) {
      dispatch({ type: 'FILE_ANALYZED', payload: result });
      return true;
    }
    return false;
  }, [shotType, handedness, dbBenchmarks]);

  return {
    ...state,
    startCamera,
    startFromVideoElement,
    analyzeImage,
    stopCamera,
    finalizeFileAnalysis,
    startNextShot,
    startPrepCountdown,
    skipPrepCountdown,
    reanalyzeFromBuffer,
    // worldLandmarks is already in ...state (from INITIAL_STATE + reducer)
  };
}
