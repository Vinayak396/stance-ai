import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import SkeletonOverlay from './SkeletonOverlay';
import { usePoseDetection } from '../hooks/usePoseDetection';
import { computeSideViewMetrics } from '../lib/biomechanics';

/**
 * DualCameraView
 * ==============
 * Front camera (laptop): standard joint angles via usePoseDetection.
 * Side camera (phone):   pose landmarks only — fed into computeSideViewMetrics
 *                        which covers TWO categories:
 *                          1) Footwork  : stride, weight transfer, back-foot shift
 *                          2) Blind spots: head position, elbow tuck, knee drive,
 *                             hip crouch — geometry the front cam cannot see
 *                        Results are merged with front-cam angles into one unified
 *                        analysis card. No separate second feed.
 *
 * Props:
 *   shotType      string   - cricket shot type
 *   dbBenchmarks  object   - optional Supabase benchmarks
 *   cam1Id / setCam1Id / cam2Id / setCam2Id / deviceList / swapCameras
 *   handedness    'RHB'|'LHB'
 *   flipSideCam   boolean  - reverse front/back foot direction for phone cam
 *   onMergedAngles fn      - called with combined joint+stride metrics each frame
 */
export default function DualCameraView({
  shotType     = 'COVER_DRIVE',
  dbBenchmarks = null,
  cam1Id       = '',
  cam2Id       = '',
  setCam1Id,
  setCam2Id,
  deviceList   = [],
  swapCameras,
  handedness   = 'RHB',
  flipSideCam  = false,
  onMergedAngles,
  onFlipToggle,
}) {
  const video1Ref = useRef(null);
  const video2Ref = useRef(null);

  // Front cam: full joint-angle pipeline
  const cam1 = usePoseDetection({ shotType, dbBenchmarks, videoRef: video1Ref });

  // Side cam: landmarks only (we call computeStrideMetrics ourselves)
  const cam2 = usePoseDetection({ shotType, dbBenchmarks, videoRef: video2Ref });

  // Raw side-cam landmarks — kept in state for merging
  const [sideLandmarks, setSideLandmarks] = useState([]);

  // Track side landmarks whenever cam2 detects a pose
  useEffect(() => {
    if (cam2.landmarks && cam2.landmarks.length > 0) {
      setSideLandmarks(cam2.landmarks);
    } else if (!cam2.isRunning) {
      setSideLandmarks([]);
    }
  }, [cam2.landmarks, cam2.isRunning]);

  // Track dims per camera
  const dims1Ref = useRef({ width: 640, height: 480 });
  const dims2Ref = useRef({ width: 640, height: 480 });

  const handleMeta1 = useCallback(() => {
    const v = video1Ref.current;
    if (v) dims1Ref.current = { width: v.videoWidth || 640, height: v.videoHeight || 480 };
  }, []);

  const handleMeta2 = useCallback(() => {
    const v = video2Ref.current;
    if (v) dims2Ref.current = { width: v.videoWidth || 640, height: v.videoHeight || 480 };
  }, []);

  // Merge: front joint angles + ALL side-view metrics (footwork + blind spots)
  const mergedAngles = useMemo(() => {
    const sideMetrics = sideLandmarks.length > 0
      ? computeSideViewMetrics(sideLandmarks, shotType, handedness, flipSideCam, dbBenchmarks)
      : [];
    return [...cam1.jointAngles, ...sideMetrics];
  }, [cam1.jointAngles, sideLandmarks, shotType, handedness, flipSideCam, dbBenchmarks]);

  // Bubble merged result up to Dashboard
  useEffect(() => {
    if (onMergedAngles) onMergedAngles(mergedAngles);
  }, [mergedAngles, onMergedAngles]);

  // Start / stop helpers
  const startCam1 = useCallback(() => cam1.startCamera(cam1Id || null), [cam1, cam1Id]);
  const startCam2 = useCallback(() => cam2.startCamera(cam2Id || null), [cam2, cam2Id]);

  const stopBoth  = useCallback(() => { cam1.stopCamera(); cam2.stopCamera(); }, [cam1, cam2]);
  const startBoth = useCallback(() => { startCam1(); startCam2(); }, [startCam1, startCam2]);

  const isModelReady  = cam1.isModelReady;
  const eitherRunning = cam1.isRunning || cam2.isRunning;

  return (
    <div className="dual-camera-root">
      {/* Top action bar */}
      <div className="dual-action-bar">
        <span className="panel-title">Dual Camera Feed</span>
        <div className="dual-action-controls">
          {swapCameras && (
            <button
              id="btn-swap-cameras"
              className="btn btn-secondary btn-sm"
              onClick={swapCameras}
              disabled={eitherRunning}
              title="Swap camera assignments"
            >
              🔄 Swap
            </button>
          )}
          {eitherRunning ? (
            <button id="btn-stop-both" className="btn btn-danger btn-sm" onClick={stopBoth}>
              ⏹ Stop Both
            </button>
          ) : (
            <button
              id="btn-start-both"
              className="btn btn-primary btn-sm"
              onClick={startBoth}
              disabled={!isModelReady}
              title={!isModelReady ? 'Model loading...' : 'Start both cameras'}
            >
              {isModelReady ? '▶ Start Both' : '⏳ Loading...'}
            </button>
          )}
        </div>
      </div>

      {/* Side-by-side feeds */}
      <div className="dual-feeds-grid">
        <CameraFeedPanel
          label="Camera 1 — Front"
          icon="💻"
          videoRef={video1Ref}
          pose={cam1}
          dimsRef={dims1Ref}
          deviceId={cam1Id}
          setDeviceId={setCam1Id}
          deviceList={deviceList}
          onLoadedMetadata={handleMeta1}
          onStart={startCam1}
          isModelReady={isModelReady}
        />

        <div className="cam-divider" aria-hidden="true" />

        <CameraFeedPanel
          label="Camera 2 — Side"
          icon="📱"
          videoRef={video2Ref}
          pose={cam2}
          dimsRef={dims2Ref}
          deviceId={cam2Id}
          setDeviceId={setCam2Id}
          deviceList={deviceList}
          onLoadedMetadata={handleMeta2}
          onStart={startCam2}
          isModelReady={isModelReady}
          isSideCam
          flipSideCam={flipSideCam}
          onFlipToggle={onFlipToggle}
        />
      </div>
    </div>
  );
}

// Single Camera Feed Panel

function CameraFeedPanel({
  label, icon, videoRef, pose, dimsRef,
  deviceId, setDeviceId, deviceList,
  onLoadedMetadata, onStart, isModelReady,
  isSideCam = false, flipSideCam = false, onFlipToggle,
}) {
  const { isRunning, landmarks, jointAngles, fps, error, stopCamera } = pose;

  return (
    <div className="camera-feed-panel glass-card">
      {/* Label bar */}
      <div className="camera-label-bar">
        <div className="camera-label-left">
          <span className="camera-icon">{icon}</span>
          <span className="camera-label-text">{label}</span>
          {isRunning && (
            <div className="live-badge">
              <div className="pulse-dot" />
              <span>LIVE</span>
            </div>
          )}
          {/* Side-cam role badge */}
          {isSideCam && (
            <span className="side-cam-role-badge">STRIDE VIEW</span>
          )}
        </div>
        <div className="camera-label-right">
          {isRunning && <span className="cam-fps text-mono text-muted">{fps} fps</span>}

          {/* Flip side-cam toggle */}
          {isSideCam && onFlipToggle && (
            <button
              className={`btn btn-xs ${flipSideCam ? 'btn-accent' : 'btn-secondary'}`}
              onClick={onFlipToggle}
              title={flipSideCam ? 'Flip: player faces LEFT in frame' : 'Flip: player faces RIGHT in frame'}
            >
              ↔ {flipSideCam ? 'Flipped' : 'Normal'}
            </button>
          )}

          {deviceList.length > 0 && (
            <select
              className="camera-device-select"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              disabled={isRunning}
              title="Select camera device"
            >
              {deviceList.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
          )}

          {isRunning ? (
            <button className="btn btn-danger btn-xs" onClick={stopCamera} title="Stop this camera">⏹</button>
          ) : (
            <button
              className="btn btn-primary btn-xs"
              onClick={onStart}
              disabled={!isModelReady}
              title={isModelReady ? 'Start this camera' : 'Model loading...'}
            >
              ▶
            </button>
          )}
        </div>
      </div>

      {/* Video + skeleton overlay */}
      <div className="camera-video-wrapper">
        <video
          ref={videoRef}
          className="video-element"
          autoPlay
          playsInline
          muted
          onLoadedMetadata={onLoadedMetadata}
        />
        <SkeletonOverlay
          landmarks={landmarks}
          jointAngles={isSideCam ? [] : jointAngles}
          videoRef={videoRef}
          showAngles={!isSideCam}
        />
        {!isRunning && landmarks.length === 0 && (
          <div className="video-placeholder">
            {error ? (
              <>
                <div className="placeholder-icon" style={{ fontSize:'1.8rem' }}>⚠️</div>
                <p className="text-sm" style={{ color:'#ff1744', maxWidth:220, textAlign:'center' }}>{error}</p>
              </>
            ) : (
              <>
                <div className="placeholder-icon">{icon}</div>
                <p className="text-muted text-sm">
                  {isSideCam ? 'Side view — measures stride & weight transfer' : 'Press ▶ to start this feed'}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="camera-feed-footer">
        <span className="text-muted text-sm">
          {landmarks.length > 0 ? `${landmarks.length} landmarks` : 'No pose detected'}
        </span>
        {isSideCam ? (
          <span className="text-muted text-sm" style={{ color: 'var(--accent-primary)', fontSize:'0.68rem' }}>
            {landmarks.length > 0 ? 'Stride data active' : 'Awaiting side view...'}
          </span>
        ) : (
          <span className="text-muted text-sm">
            {jointAngles.length > 0 && `${jointAngles.filter(j => j.quality==='OPTIMAL').length}/${jointAngles.length} optimal`}
          </span>
        )}
      </div>
    </div>
  );
}
