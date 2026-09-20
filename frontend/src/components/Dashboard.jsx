import { useState, useRef, useEffect, useCallback } from 'react';
import SkeletonOverlay from './SkeletonOverlay';
import DualCameraView from './DualCameraView';
import { usePoseDetection } from '../hooks/usePoseDetection';
import { useDualCamera } from '../hooks/useDualCamera';
import { startSession, endSession, getBenchmarks } from '../api/biomechanicsApi';
import './Dashboard.css';

const SHOT_TYPES = [
  { value: 'COVER_DRIVE', label: 'Cover Drive' },
  { value: 'PULL_SHOT', label: 'Pull Shot' },
  { value: 'FORWARD_DEFENSE', label: 'Forward Defense' },
  { value: 'SWEEP_SHOT', label: 'Sweep Shot' },
  { value: 'CUT_SHOT', label: 'Cut Shot' },
  { value: 'STRAIGHT_DRIVE', label: 'Straight Drive' },
  { value: 'HOOK_SHOT', label: 'Hook Shot' },
  { value: 'ON_DRIVE', label: 'On Drive' },
  { value: 'LOFTED_DRIVE', label: 'Lofted Drive' },
  { value: 'FLICK_SHOT', label: 'Flick Shot' },
  { value: 'DEFENSIVE_LEAVE', label: 'Defensive Leave' },
];


const QUALITY_LABELS = {
  OPTIMAL: { label: 'Optimal', cls: 'badge-optimal' },
  WARNING: { label: 'Warning', cls: 'badge-warning' },
  CRITICAL: { label: 'Critical', cls: 'badge-critical' },
  UNCLASSIFIED: { label: 'N/A', cls: 'badge-inactive' },
};

/**
 * Dashboard — Main StanceAI UI
 * =============================
 * - Left: Video feed (webcam or file upload) + canvas skeleton overlay
 * - Right: Live joint angle metrics panel + session controls
 */
export default function Dashboard() {
  // ── Refs ─────────────────────────────────────────────────────────────
  const videoRef = useRef(null);
  const imgRef = useRef(null);
  const videoDimsRef = useRef({ width: 640, height: 480 });

  // ── UI State ──────────────────────────────────────────────────
  const [shotType, setShotType] = useState('COVER_DRIVE');
  const [sessionId, setSessionId] = useState(null);
  const [dbBenchmarks, setDbBenchmarks] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  // uploadedFile tracks the most-recently loaded file for re-analysis
  const [uploadedFile, setUploadedFile] = useState(null); // { url, type: 'image'|'video' }
  const [uploadRunning, setUploadRunning] = useState(false); // video upload loop active
  // Video frame scaling mode: 'contain' (full frame, uncropped) or 'cover' (fill panel)
  const [fitMode, setFitMode] = useState('contain');
  // Dual-camera Pro Mode
  const [dualMode, setDualMode] = useState(false);
  const [dualMergedAngles, setDualMergedAngles] = useState([]); // unified front+stride angles
  // Handedness: RHB (right-hand bat) or LHB (left-hand bat) — applies to single & dual modes
  const [handedness, setHandedness] = useState('RHB');
  // flipSideCam: reverse front/back foot direction when phone is on the opposite side (dual mode only)
  const [flipSideCam, setFlipSideCam] = useState(false);
  // Camera setup tip: dismissible once-per-session
  const [setupTipDismissed, setSetupTipDismissed] = useState(false);

  // ── Dual camera device management ────────────────────────────────────
  const {
    deviceList,
    cam1Id, setCam1Id,
    cam2Id, setCam2Id,
    swapCameras,
    hasTwoCameras,
    permissionError,
    requestPermission,
  } = useDualCamera();

  const handleFileVideoEnded = useCallback(() => {
    setUploadRunning(false);
  }, []);

  // ── Pose Detection Hook (runs MediaPipe WASM in-browser) ─────────────
  const {
    isModelReady,
    isRunning,
    error,
    landmarks,
    worldLandmarks,
    jointAngles,
    fps,
    frameCount,
    videoAnalysis,
    prepCountdown,
    shotDetectionState,
    startCamera,
    startFromVideoElement,
    analyzeImage,
    stopCamera,
    finalizeFileAnalysis,
    startNextShot,
    skipPrepCountdown,
    reanalyzeFromBuffer,
  } = usePoseDetection({
    shotType,
    dbBenchmarks,
    videoRef,
    handedness,
    onFileVideoEnded: handleFileVideoEnded,
  });

  // ── Load benchmarks from Supabase when shot type changes ─────────────
  useEffect(() => {
    getBenchmarks(shotType)
      .then(data => setDbBenchmarks(Object.keys(data).length > 0 ? data : null))
      .catch(() => setDbBenchmarks(null));
  }, [shotType]);

  // ── Toggle dual mode ──────────────────────────────────────────────────
  const handleDualModeToggle = useCallback(() => {
    // Stop any active single-camera session first
    if (isRunning) stopCamera();
    setDualMode((prev) => !prev);
    // Request camera permission so device labels are populated
    if (!dualMode) requestPermission();
  }, [dualMode, isRunning, stopCamera, requestPermission]);

  // ── Start Analysis ───────────────────────────────────────────────────
  const startStream = useCallback(async () => {
    try {
      const session = await startSession('anonymous', shotType, 'WEBCAM');
      setSessionId(session.session_id);
    } catch {
      // Non-fatal: analysis works without DB
      setSessionId(null);
    }
    startCamera();
  }, [startCamera, shotType]);

  // ── Stop Analysis ────────────────────────────────────────────────────
  const stopStream = useCallback(async () => {
    stopCamera();
    if (sessionId) {
      const anomalyCount = jointAngles.filter(j => j.quality === 'CRITICAL' || j.quality === 'WARNING').length;
      await endSession(sessionId, {
        totalFrames: frameCount,
        flaggedFrames: anomalyCount,
      }).catch(() => { });
      setSessionId(null);
    }
  }, [stopCamera, sessionId, frameCount, jointAngles]);

  // ── Handle File Upload ────────────────────────────────────────────────
  const handleFileUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (!isModelReady) return;
    if (isRunning) stopCamera();

    const url = URL.createObjectURL(file);
    const isImage = file.type.startsWith('image/');

    // Persist for re-analysis
    setUploadedFile({ url, type: isImage ? 'image' : 'video' });

    if (isImage) {
      if (videoRef.current) { videoRef.current.srcObject = null; videoRef.current.src = ''; }
      setImageUrl(url);
      setUploadRunning(false);
      const img = new Image();
      img.onload = () => {
        videoDimsRef.current = { width: img.naturalWidth, height: img.naturalHeight };
        analyzeImage(img);
      };
      img.src = url;
    } else {
      setImageUrl(null);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = null;
      video.src = url;
      video.loop = false;
      video.oncanplay = () => {
        video.oncanplay = null;
        startFromVideoElement();
        video.play().catch(() => { });
        setUploadRunning(true);
      };
    }
  }, [isModelReady, isRunning, stopCamera, videoRef, analyzeImage, startFromVideoElement]);

  // ── Re-analyze uploaded file with current shot type ──────────────────
  const reanalyzeUpload = useCallback(() => {
    if (!uploadedFile) return;

    if (uploadedFile.type === 'image') {
      // Re-analyze the already-rendered image element directly
      const existingImg = imgRef.current;
      if (existingImg && existingImg.complete && existingImg.naturalWidth > 0) {
        videoDimsRef.current = { width: existingImg.naturalWidth, height: existingImg.naturalHeight };
        analyzeImage(existingImg);
        return;
      }
      // Fallback: load a fresh Image from the blob URL
      const img = new Image();
      img.onload = () => {
        videoDimsRef.current = { width: img.naturalWidth, height: img.naturalHeight };
        analyzeImage(img);
      };
      img.src = uploadedFile.url;
      if (img.complete && img.naturalWidth > 0) {
        videoDimsRef.current = { width: img.naturalWidth, height: img.naturalHeight };
        analyzeImage(img);
      }
    } else {
      // Video: always replay from frame 0 so MediaPipe re-processes every frame
      // with the current shot type and benchmarks.
      // The blob URL is still valid (uploadedFile.url) — we just rewind and replay.
      const video = videoRef.current;
      if (!video) return;

      // Stop any active loop / finalize any running analysis first
      if (isRunning) stopCamera();

      // Reset video to start and replay through MediaPipe
      video.src = uploadedFile.url; // re-assign ensures video is loaded
      video.currentTime = 0;
      video.loop = false;
      video.oncanplay = () => {
        video.oncanplay = null;
        startFromVideoElement();
        video.play().catch(() => { });
        setUploadRunning(true);
      };
      // If the video is already ready (cached), fire canplay immediately
      if (video.readyState >= 3) {
        video.dispatchEvent(new Event('canplay'));
      }
    }
  }, [uploadedFile, analyzeImage, imgRef, videoRef, isRunning, stopCamera, startFromVideoElement]);


  // ── Stop uploaded video analysis ──────────────────────────────────
  const stopUploadAnalysis = useCallback(() => {
    finalizeFileAnalysis?.();
    setUploadRunning(false);
  }, [finalizeFileAnalysis]);

  // ── Track Video Dimensions for Canvas Sizing ──────────────────────────
  const handleVideoMetadata = useCallback(() => {
    if (videoRef.current) {
      videoDimsRef.current = {
        width: videoRef.current.videoWidth || 640,
        height: videoRef.current.videoHeight || 480,
      };
    }
  }, []);

  // ── Status Indicator ───────────────────────────────────────────────
  // Derived: is the upload loop currently active?
  const isUploadVideoRunning = isRunning && uploadedFile?.type === 'video' && uploadRunning;

  const status = error
    ? { color: '#ff1744', label: error }
    : isUploadVideoRunning
      ? { color: '#00e676', label: `File · ${fps} fps` }
      : isRunning
        ? { color: '#00e676', label: `Live · ${fps} fps` }
        : imageUrl && landmarks.length > 0
          ? { color: '#7c4dff', label: 'Photo · analyzed' }
          : uploadedFile?.type === 'video' && videoAnalysis
            ? { color: '#7c4dff', label: 'Video · Analyzed' }
            : isModelReady
              ? { color: '#00b0ff', label: 'Model Ready' }
              : { color: '#90a4ae', label: 'Loading Model...' };

  return (
    <>
      {/* Animated background gradient */}
      <div className="animated-bg" />

      <div className="dashboard">
        {/* ── Header ──────────────────────────────────────────────────── */}
        <header className="dashboard-header">
          <div className="header-brand">
            <div className="brand-icon" aria-hidden="true">🏏</div>
            <div className="brand-text">
              <h1 className="brand-title">StanceAI</h1>
              <span className="brand-subtitle">Biomechanical Cricket Analyzer</span>
            </div>
          </div>

          <div className="header-controls">
            {/* Shot type selector */}
            <div className="control-group">
              <label htmlFor="shot-type-select" className="control-label">Shot Type</label>
              <select
                id="shot-type-select"
                className="control-select"
                value={shotType}
                onChange={(e) => setShotType(e.target.value)}
                disabled={isRunning}
              >
                {SHOT_TYPES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>

            <div className="control-group">
              <label className="control-label">Input</label>
              <label
                className={`source-btn${!isModelReady ? ' disabled' : ''}`}
                htmlFor="file-upload-input"
                style={!isModelReady ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
                title={!isModelReady ? 'Please wait, AI model is downloading & warming up...' : 'Upload cricket video or photo'}
              >
                {!isModelReady ? '⏳ Model Loading...' : '📁 Upload Video / Photo'}
                <input
                  id="file-upload-input"
                  type="file"
                  accept="video/*,image/*"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
                  disabled={!isModelReady}
                />
              </label>
            </div>

            {/* Upload file control — shown only when a file is loaded */}
            {uploadedFile && (
              <div className="control-group">
                <label className="control-label">
                  {uploadedFile.type === 'image' ? 'Photo Analysis' : 'Video Analysis'}
                </label>
                {isUploadVideoRunning ? (
                  <button
                    id="btn-stop-upload"
                    className="btn btn-danger btn-sm"
                    onClick={stopUploadAnalysis}
                  >
                    ⏹ Stop
                  </button>
                ) : (
                  <button
                    id="btn-reanalyze-upload"
                    className="btn btn-accent btn-sm"
                    onClick={reanalyzeUpload}
                    disabled={!isModelReady || isUploadVideoRunning}
                    title={isUploadVideoRunning ? 'Analysis running…' : 'Re-run analysis with current shot type'}
                  >
                    ⟳ Re-analyze
                  </button>
                )}
              </div>
            )}

            {/* Handedness toggle — always shown (applies to 3D single & dual modes) */}
            <div className="control-group">
              <label className="control-label">Batting</label>
              <div className="source-toggle">
                <button
                  id="btn-rhb"
                  className={`source-btn${handedness === 'RHB' ? ' active' : ''}`}
                  onClick={() => setHandedness('RHB')}
                  title="Right-hand bat"
                >
                  RHB
                </button>
                <button
                  id="btn-lhb"
                  className={`source-btn${handedness === 'LHB' ? ' active' : ''}`}
                  onClick={() => setHandedness('LHB')}
                  title="Left-hand bat"
                >
                  LHB
                </button>
              </div>
            </div>

            {/* Pro Mode (Dual Camera) toggle */}
            <button
              id={dualMode ? 'btn-single-cam' : 'btn-dual-cam'}
              className={`btn btn-sm ${dualMode ? 'btn-accent' : 'btn-secondary'}`}
              onClick={handleDualModeToggle}
              title={dualMode ? 'Switch to single camera (recommended)' : 'Switch to Pro Mode: dual camera (laptop + phone)'}
            >
              {dualMode ? '📷 Single Camera' : '📷📱 Pro Mode'}
            </button>

            {/* Webcam stream toggle — hidden in dual mode (each feed has its own controls) */}
            {!dualMode && (
              <button
                id={isRunning && !uploadRunning ? 'btn-stop-stream' : 'btn-start-stream'}
                className={`btn ${isRunning && !uploadRunning ? 'btn-danger' : 'btn-primary'}`}
                onClick={isRunning && !uploadRunning ? stopStream : startStream}
                disabled={!isModelReady || isUploadVideoRunning}
                title={isUploadVideoRunning ? 'Stop file analysis first' : undefined}
              >
                {isRunning && !uploadRunning
                  ? '⏹ Stop Webcam'
                  : isModelReady
                    ? '▶ Start Webcam'
                    : '⏳ Loading...'}
              </button>
            )}
          </div>

          {/* Status pill */}
          <div className="status-pill" style={{ '--status-color': status.color }}>
            <span className="status-dot" />
            <span className="status-label">{status.label}</span>
            {isRunning && <span className="status-frame-count">Frame {frameCount}</span>}
          </div>
        </header>

        {/* ── Main Layout ─────────────────────────────────────────────── */}
        <main className={`dashboard-main${dualMode ? ' dashboard-main--dual' : ''}`}>

          {/* ── Left: Video Panel (single or dual) ───────────────────── */}
          {dualMode ? (
            /* ── Dual camera mode ─────────────────────────────────────── */
            <section className="video-panel glass-card dual-mode-panel" aria-label="Dual camera feed">
              {permissionError && (
                <div className="dual-permission-error">
                  <span>⚠️ {permissionError}</span>
                </div>
              )}
              <DualCameraView
                shotType={shotType}
                dbBenchmarks={dbBenchmarks}
                cam1Id={cam1Id}
                cam2Id={cam2Id}
                setCam1Id={setCam1Id}
                setCam2Id={setCam2Id}
                deviceList={deviceList}
                swapCameras={swapCameras}
                handedness={handedness}
                flipSideCam={flipSideCam}
                onMergedAngles={setDualMergedAngles}
                onFlipToggle={() => setFlipSideCam(f => !f)}
              />
            </section>
          ) : (
            /* ── Single camera mode (original) ────────────────────────── */
            <section className="video-panel glass-card" aria-label="Video feed with skeleton overlay">
              <div className="video-panel-header">
                <div className="panel-header-left">
                  <span className="panel-title">Live Feed</span>
                  <div className="fit-toggle" role="group" aria-label="Video scaling mode">
                    <button
                      type="button"
                      className={`fit-btn${fitMode === 'contain' ? ' active' : ''}`}
                      onClick={() => setFitMode('contain')}
                      title="Full Frame (no cropping - shows full video/photo)"
                    >
                      ⛶ Full Frame
                    </button>
                    <button
                      type="button"
                      className={`fit-btn${fitMode === 'cover' ? ' active' : ''}`}
                      onClick={() => setFitMode('cover')}
                      title="Fill (crops to fill entire panel)"
                    >
                      🔲 Fill
                    </button>
                  </div>
                </div>

                <div className="panel-header-right">
                  {isUploadVideoRunning && (
                    <div className="live-badge" style={{ borderColor: 'rgba(0,230,118,0.3)' }}>
                      <div className="pulse-dot" />
                      <span>FILE</span>
                    </div>
                  )}
                  {isRunning && !uploadRunning && (
                    <>
                      {shotDetectionState === 'PREPARING' && (
                        <div className="live-badge badge-prep">
                          <div className="pulse-dot pulse-dot--amber" />
                          <span>GET READY ({typeof prepCountdown === 'number' ? prepCountdown : 5}s)</span>
                        </div>
                      )}
                      {shotDetectionState === 'ACTIVE' && (
                        <div className="live-badge badge-stroke">
                          <div className="pulse-dot pulse-dot--cyan" />
                          <span>STROKE DETECTED</span>
                        </div>
                      )}
                      {shotDetectionState === 'IDLE' && (
                        <div className="live-badge badge-ready">
                          <div className="pulse-dot" />
                          <span>IN STANCE · READY</span>
                        </div>
                      )}
                      {shotDetectionState === 'COOLING' && (
                        <div className="live-badge badge-analyzed">
                          <span>✓ SHOT ANALYZED</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="video-wrapper">
                {/* Static image display (photo upload) */}
                {imageUrl ? (
                  <img
                    ref={imgRef}
                    src={imageUrl}
                    alt="Uploaded photo for pose analysis"
                    className={`video-element fit-${fitMode}`}
                    style={{ width: '100%', height: '100%', display: 'block' }}
                  />
                ) : (
                  /* Video element (webcam or video file) */
                  <video
                    ref={videoRef}
                    id="stance-video"
                    className={`video-element fit-${fitMode}`}
                    autoPlay
                    playsInline
                    muted
                    onEnded={() => {
                      finalizeFileAnalysis?.();
                      handleFileVideoEnded();
                    }}
                    onLoadedMetadata={handleVideoMetadata}
                  />
                )}

                {/* Canvas overlay — absolutely positioned over image/video */}
                <SkeletonOverlay
                  landmarks={landmarks}
                  jointAngles={jointAngles}
                  videoRef={videoRef}
                  imgRef={imgRef}
                  fitMode={fitMode}
                  showAngles={true}
                />

                {/* Preparation Countdown Overlay for live webcam drills */}
                {prepCountdown !== null && isRunning && !uploadRunning && (
                  <div className="prep-overlay fade-in">
                    <div className="prep-card">
                      <div className="prep-tag">BATSMAN PREPARATION</div>
                      {typeof prepCountdown === 'number' && prepCountdown > 0 ? (
                        <>
                          <div className="prep-countdown-number" key={prepCountdown}>
                            {prepCountdown}
                          </div>
                          <div className="prep-prompt">Walk back &amp; take your batting stance</div>
                          <p className="prep-subtext">Shot detection begins when countdown finishes</p>
                          <button
                            type="button"
                            className="btn btn-sm btn-accent prep-skip-btn"
                            onClick={skipPrepCountdown}
                          >
                            ⚡ Ready Now
                          </button>
                        </>
                      ) : (
                        <div className="prep-ready-callout">
                          <div className="prep-ready-icon">🏏</div>
                          <div className="prep-ready-title">READY! PLAY YOUR SHOT</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Camera setup tip — shown only in single-camera mode, dismissible */}
                {!dualMode && !setupTipDismissed && !isRunning && !imageUrl && (
                  <div className="camera-setup-tip">
                    <span className="setup-tip-icon">💡</span>
                    <span className="setup-tip-text">
                      <strong>Best results:</strong> Place camera at a
                      <strong> 30–45° angle</strong> (Extra-Cover / Mid-Wicket).
                      Single camera now detects stride &amp; footwork automatically!
                    </span>
                    <button
                      className="setup-tip-dismiss"
                      onClick={() => setSetupTipDismissed(true)}
                      aria-label="Dismiss tip"
                    >✕</button>
                  </div>
                )}

                {/* Empty state message */}
                {!isRunning && !imageUrl && landmarks.length === 0 && (
                  <div className="video-placeholder">
                    <div className="placeholder-icon">🦴</div>
                    <p>Press <strong>Start Webcam</strong> to begin</p>
                    <p className="text-muted text-sm">Single camera · 3D pose analysis · No server required</p>
                  </div>
                )}
              </div>

              <div className="video-panel-footer">
                <span className="text-muted text-sm">
                  {landmarks.length > 0
                    ? `${landmarks.length} landmarks detected`
                    : 'Awaiting pose detection...'}
                </span>
                {isRunning && (
                  <span className="text-muted text-sm">
                    {fps} fps · In-browser inference
                  </span>
                )}
              </div>
            </section>
          )}

          {/* ── Right: Metrics Panel ─────────────────────────────────── */}
          <aside className="metrics-panel">
            {dualMode ? (
              /* Dual-camera mode: one unified metrics card (front joints + side stride) */
              <CombinedMetricsCard
                jointAngles={dualMergedAngles}
                shotType={shotType}
              />
            ) : (
              /* ── Single-camera metrics (original) ─────────────────── */
              <>
                {/* Analysis Results Card */}
                <div className="glass-card metrics-card metrics-card--analysis fade-in-up">
                  <div className="metrics-header">
                    <div className="metrics-header-left">
                      <span className="panel-title">Analysis</span>
                      <span className="badge badge-inactive">{shotType.replace(/_/g, ' ')}</span>
                    </div>
                    {videoAnalysis && (
                      <button
                        id="btn-next-shot"
                        className="btn btn-xs btn-primary next-shot-btn"
                        onClick={() => startNextShot(5)}
                        title="Clear and prepare to record your next shot"
                      >
                        🎯 Next Shot
                      </button>
                    )}
                  </div>
                  <VideoAnalysisDisplay
                    videoAnalysis={videoAnalysis}
                    jointAngles={jointAngles}
                    isRunning={isRunning}
                    prepCountdown={prepCountdown}
                    shotDetectionState={shotDetectionState}
                    onNextShot={() => startNextShot(5)}
                  />
                </div>

                {/* Session Summary Card — Compact */}
                <div className="glass-card metrics-card metrics-card--session fade-in-up" style={{ animationDelay: '80ms' }}>
                  <div className="metrics-header">
                    <span className="panel-title">Session</span>
                  </div>
                  <div className="session-stats-compact">
                    <div className="stat-item-compact">
                      <span className="stat-val-compact text-mono">{frameCount}</span>
                      <span className="stat-lbl-compact">Frames</span>
                    </div>
                    <div className="stat-item-compact">
                      <span className="stat-val-compact text-mono">
                        {videoAnalysis
                          ? (videoAnalysis.overallQuality.score != null
                              ? `${videoAnalysis.overallQuality.score}`
                              : `${videoAnalysis.overallQuality.optimal}`)
                          : jointAngles.filter(j => j.quality === 'OPTIMAL').length}
                        <span className="text-muted" style={{ fontSize: '0.7rem' }}>
                          {videoAnalysis?.overallQuality.score != null ? '/100' : `/${videoAnalysis ? videoAnalysis.overallQuality.total : jointAngles.length}`}
                        </span>
                      </span>
                      <span className="stat-lbl-compact">{videoAnalysis?.overallQuality.score != null ? 'Score' : 'Optimal'}</span>
                    </div>
                    <div className="stat-item-compact">
                      <span className="stat-val-compact text-mono" style={{ color: isRunning ? '#00e676' : '#90a4ae' }}>
                        {isRunning ? `${fps} fps` : 'Idle'}
                      </span>
                      <span className="stat-lbl-compact">Inference</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Legend Card — Compact */}
            <div className="glass-card metrics-card metrics-card--legend fade-in-up" style={{ animationDelay: '160ms' }}>
              <div className="metrics-header">
                <span className="panel-title">Legend</span>
              </div>
              <div className="legend-pills">
                <span className="legend-pill" title="Within benchmark range">
                  <span className="legend-dot" style={{ background: '#00e676' }} />Optimal
                </span>
                <span className="legend-pill" title="Moderate deviation">
                  <span className="legend-dot" style={{ background: '#ffd600' }} />Warning
                </span>
                <span className="legend-pill" title="Significant deviation">
                  <span className="legend-dot" style={{ background: '#ff1744' }} />Critical
                </span>
                <span className="legend-pill" title="No benchmark for this joint">
                  <span className="legend-dot" style={{ background: '#90a4ae' }} />No Data
                </span>
              </div>
            </div>
          </aside>
        </main>
      </div>
    </>
  );
}

// ─── Sub-component: Angle Range Bar ──────────────────────────────────────────

function AngleRangeBar({ value, min, max, quality }) {
  const DISPLAY_MIN = 0;
  const DISPLAY_MAX = 180;
  const range = DISPLAY_MAX - DISPLAY_MIN;

  const clamp = (v) => Math.max(DISPLAY_MIN, Math.min(DISPLAY_MAX, v));
  const pct = (v) => `${((clamp(v) - DISPLAY_MIN) / range) * 100}%`;

  const colors = {
    OPTIMAL: '#00e676',
    WARNING: '#ffd600',
    CRITICAL: '#ff1744',
    UNCLASSIFIED: '#90a4ae',
  };

  const isOptimal = quality === 'OPTIMAL';
  // Zone is "lit" when the marker sits inside the optimal range
  const isInsideZone = value >= min && value <= max;
  const markerColor = colors[quality] || colors.UNCLASSIFIED;

  return (
    <div className="range-bar" role="meter" aria-valuenow={value} aria-valuemin={DISPLAY_MIN} aria-valuemax={DISPLAY_MAX}>
      {/* Optimal zone — glows when marker is inside */}
      <div
        className={`range-zone${isInsideZone ? ' range-zone--lit' : ''}`}
        style={{
          left: pct(min),
          width: `${((clamp(max) - clamp(min)) / range) * 100}%`,
        }}
      />
      {/* Current angle marker — pulses green when optimal */}
      <div
        className={`range-marker${isOptimal ? ' range-marker--optimal' : ''}`}
        style={{
          left: pct(value),
          background: markerColor,
          boxShadow: isOptimal ? undefined : `0 0 6px ${markerColor}`,
        }}
      />
    </div>
  );
}


// ─── Sub-component: Combined Metrics Card (dual-camera unified view) ───────────
/**
 * Shows front-camera joint angles + side-camera stride metrics in one card.
 * Each row is tagged with a source badge (FRONT / SIDE).
 * A divider separates the two data sources when both are present.
 */
function CombinedMetricsCard({ jointAngles, shotType }) {
  const Q = {
    OPTIMAL: { label: 'OPT', cls: 'badge-optimal' },
    WARNING: { label: 'WARN', cls: 'badge-warning' },
    CRITICAL: { label: 'CRIT', cls: 'badge-critical' },
    UNCLASSIFIED: { label: 'N/A', cls: 'badge-inactive' },
  };

  const frontAngles = jointAngles.filter(ja => ja.source !== 'SIDE');
  const sideMetrics = jointAngles.filter(ja => ja.source === 'SIDE');
  const hasSide = sideMetrics.length > 0;

  const renderRow = (ja, idx) => {
    const q = Q[ja.quality] || Q.UNCLASSIFIED;
    const isSide = ja.source === 'SIDE';
    return (
      <li
        key={`${ja.source}-${ja.jointName}-${idx}`}
        className={`joint-row${isSide ? ' joint-row--stride' : ''}`}
      >
        <div className="joint-info">
          <span className="joint-name" style={{ fontSize: '0.68rem' }}>
            {ja.jointName.replace(/_/g, ' ')}
            <span className={`joint-source-badge joint-source-badge--${isSide ? 'side' : 'front'}`}>
              {isSide ? 'SIDE' : 'FRONT'}
            </span>
          </span>
          <span className={`badge ${q.cls}`}>{q.label}</span>
        </div>
        <div className="joint-metrics">
          <span className="joint-angle text-mono" style={{ fontSize: '0.9rem' }}>
            {ja.angleDegrees?.toFixed(1)}{isSide ? '' : '°'}
            {isSide && <span style={{ fontSize: '0.65rem', marginLeft: 3, color: 'var(--text-muted)' }}>idx</span>}
          </span>
        </div>
        {ja.optimalMin != null && ja.optimalMax != null && (
          <div className="range-bar-wrapper">
            <AngleRangeBar
              value={ja.angleDegrees}
              min={ja.optimalMin}
              max={ja.optimalMax}
              quality={ja.quality}
            />
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="glass-card metrics-card fade-in-up" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="metrics-header">
        <span className="panel-title">Combined Analysis</span>
        <span className="badge badge-inactive">{shotType.replace(/_/g, ' ')}</span>
      </div>

      {jointAngles.length === 0 ? (
        <div className="metrics-empty">
          <p className="text-muted text-sm">No pose data yet.</p>
          <p className="text-muted text-sm">Start both camera feeds.</p>
        </div>
      ) : (
        <ul className="joint-list" style={{ overflowY: 'auto', scrollbarWidth: 'thin' }}>
          {/* Front-camera joint angles */}
          {frontAngles.length > 0 && (
            <>
              <li className="joint-source-divider">
                <span>💻 Front Camera — Joint Angles</span>
              </li>
              {frontAngles.map((ja, i) => renderRow(ja, i))}
            </>
          )}

          {/* Divider between front and side metrics */}
          {hasSide && (
            <li className="joint-source-divider joint-source-divider--side">
              <span>📱 Side View — Footwork &amp; Blind Spots</span>
            </li>
          )}

          {/* Side-camera stride / weight / lean metrics */}
          {sideMetrics.map((ja, i) => renderRow(ja, i))}
        </ul>
      )}
    </div>
  );
}



// ─── Sub-component: Video Analysis Display ───────────────────────────────────

const Q_LABEL = {
  OPTIMAL: { label: 'OPT', cls: 'badge-optimal' },
  WARNING: { label: 'WARN', cls: 'badge-warning' },
  CRITICAL: { label: 'CRIT', cls: 'badge-critical' },
  UNCLASSIFIED: { label: 'N/A', cls: 'badge-inactive' },
};

/**
 * VideoAnalysisDisplay
 * Shows live joint angles while detection is running, then freezes on the
 * best-frame result when analysis is complete. Replaces the 3-phase display.
 */
function VideoAnalysisDisplay({ videoAnalysis, jointAngles, isRunning, prepCountdown, shotDetectionState, onNextShot }) {
  // Which angles to display: completed analysis or live frame
  const displayAngles = videoAnalysis ? videoAnalysis.jointAngles : jointAngles;
  const hasData = displayAngles && displayAngles.length > 0;

  if (!hasData) {
    return (
      <div className="phase-display">
        <div className="phase-waiting">
          <div className="phase-waiting-icon">🏏</div>
          <p className="phase-waiting-title">
            {prepCountdown !== null
              ? (prepCountdown > 0 ? `Get Ready (${prepCountdown}s)` : 'Ready!')
              : isRunning ? 'Detecting pose…' : 'Ready to Analyse'}
          </p>
          <p className="phase-waiting-sub">
            {isRunning
              ? 'Joint angles will appear as soon as a pose is detected.'
              : 'Upload a video or start the webcam to begin analysis.'}
          </p>
          {isRunning && shotDetectionState === 'ACTIVE' && (
            <div className="phase-recording-badge">
              <div className="phase-recording-dot" />
              SHOT DETECTED
            </div>
          )}
        </div>
      </div>
    );
  }

  const frontAngles = displayAngles.filter(ja => ja.source !== 'SIDE');
  const sideMetrics = displayAngles.filter(ja => ja.source === 'SIDE');

  // Overall score banner (only when analysis is complete)
  const oq = videoAnalysis?.overallQuality;
  // Use proximity-based score (0-100, continuous distance from optimal) instead of count ratio
  const pct = oq?.score ?? null;
  const scoreClass = pct === null ? '' :
    pct >= 80 ? 'shot-quality-score--great' :
      pct >= 60 ? 'shot-quality-score--good' :
        pct >= 40 ? 'shot-quality-score--avg' : 'shot-quality-score--poor';

  const renderJointRow = (ja, i) => {
    const q = Q_LABEL[ja.quality] || Q_LABEL.UNCLASSIFIED;
    const isSide = ja.source === 'SIDE';
    return (
      <li key={`${ja.jointName}-${i}`} className={`phase-joint-row${isSide ? ' joint-row--stride' : ''}`}>
        <span className="phase-joint-name">
          {ja.jointName.replace(/_/g, ' ')}
          {isSide && (
            <span className="joint-source-badge joint-source-badge--side">STRIDE</span>
          )}
          <span className="phase-joint-angle">{ja.angleDegrees?.toFixed(1)}{isSide ? '' : '°'}</span>
        </span>
        <div className="phase-joint-badge-wrap">
          <span className={`badge ${q.cls}`}>{q.label}</span>
        </div>
        {ja.optimalMin != null && ja.optimalMax != null && (
          <div className="phase-joint-bar-wrap">
            <AngleRangeBar
              value={ja.angleDegrees}
              min={ja.optimalMin}
              max={ja.optimalMax}
              quality={ja.quality}
            />
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="phase-display">
      {/* Score banner — only shown when analysis complete */}
      {pct !== null && (
        <div className="shot-quality-bar">
          <span className="shot-quality-label">Shot Score</span>
          <span className={`shot-quality-score ${scoreClass}`}>{pct}%</span>
          <div className="shot-quality-chips">
            {oq.optimal > 0 && <span className="quality-chip quality-chip--opt">✓ {oq.optimal}</span>}
            {oq.warning > 0 && <span className="quality-chip quality-chip--warn">⚠ {oq.warning}</span>}
            {oq.critical > 0 && <span className="quality-chip quality-chip--crit">✕ {oq.critical}</span>}
          </div>
        </div>
      )}

      {/* Next-shot button for live webcam */}
      {onNextShot && isRunning && videoAnalysis && (
        <div className="next-shot-banner">
          <button type="button" className="btn btn-sm btn-primary next-shot-action" onClick={onNextShot}>
            🎯 Ready for Next Shot
          </button>
        </div>
      )}

      {/* Joint angle list */}
      <ul className="phase-joint-list" style={{ overflowY: 'auto', scrollbarWidth: 'thin' }}>
        {frontAngles.length > 0 && (
          <>
            <li className="joint-source-divider"><span>🦴 Joint Angles</span></li>
            {frontAngles.map(renderJointRow)}
          </>
        )}
        {sideMetrics.length > 0 && (
          <>
            <li className="joint-source-divider joint-source-divider--side"><span>📏 Footwork &amp; Depth</span></li>
            {sideMetrics.map(renderJointRow)}
          </>
        )}
      </ul>
    </div>
  );
}

