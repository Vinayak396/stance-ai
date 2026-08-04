import { useState, useRef, useEffect, useCallback } from 'react';
import SkeletonOverlay from './SkeletonOverlay';
import { usePoseDetection } from '../hooks/usePoseDetection';
import { startSession, endSession, getBenchmarks } from '../api/biomechanicsApi';
import './Dashboard.css';

const SHOT_TYPES = [
  { value: 'COVER_DRIVE',      label: 'Cover Drive' },
  { value: 'PULL_SHOT',        label: 'Pull Shot' },
  { value: 'FORWARD_DEFENSE',  label: 'Forward Defense' },
  { value: 'SWEEP_SHOT',       label: 'Sweep Shot' },
  { value: 'CUT_SHOT',         label: 'Cut Shot' },
  { value: 'STRAIGHT_DRIVE',   label: 'Straight Drive' },
  { value: 'HOOK_SHOT',        label: 'Hook Shot' },
  { value: 'ON_DRIVE',         label: 'On Drive' },
  { value: 'LOFTED_DRIVE',     label: 'Lofted Drive' },
  { value: 'FLICK_SHOT',       label: 'Flick Shot' },
  { value: 'DEFENSIVE_LEAVE',  label: 'Defensive Leave' },
];


const QUALITY_LABELS = {
  OPTIMAL:      { label: 'Optimal',  cls: 'badge-optimal'  },
  WARNING:      { label: 'Warning',  cls: 'badge-warning'  },
  CRITICAL:     { label: 'Critical', cls: 'badge-critical' },
  UNCLASSIFIED: { label: 'N/A',      cls: 'badge-inactive' },
};

/**
 * Dashboard — Main StanceAI UI
 * =============================
 * - Left: Video feed (webcam or file upload) + canvas skeleton overlay
 * - Right: Live joint angle metrics panel + session controls
 */
export default function Dashboard() {
  // ── Refs ─────────────────────────────────────────────────────────────
  const videoRef       = useRef(null);
  const imgRef         = useRef(null);
  const videoDimsRef   = useRef({ width: 640, height: 480 });

  // ── UI State ──────────────────────────────────────────────────
  const [shotType,      setShotType]     = useState('COVER_DRIVE');
  const [sessionId,     setSessionId]    = useState(null);
  const [dbBenchmarks,  setDbBenchmarks] = useState(null);
  const [imageUrl,      setImageUrl]     = useState(null);
  // uploadedFile tracks the most-recently loaded file for re-analysis
  const [uploadedFile,  setUploadedFile] = useState(null); // { url, type: 'image'|'video' }
  const [uploadRunning, setUploadRunning] = useState(false); // video upload loop active

  // ── Pose Detection Hook (runs MediaPipe WASM in-browser) ─────────────
  const {
    isModelReady,
    isRunning,
    error,
    landmarks,
    jointAngles,
    fps,
    frameCount,
    startCamera,
    startFromVideoElement,
    analyzeImage,
    stopCamera,
  } = usePoseDetection({ shotType, dbBenchmarks, videoRef });

  // ── Load benchmarks from Supabase when shot type changes ─────────────
  useEffect(() => {
    getBenchmarks(shotType)
      .then(setDbBenchmarks)
      .catch(() => setDbBenchmarks(null));
  }, [shotType]);

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
        totalFrames:   frameCount,
        flaggedFrames: anomalyCount,
      }).catch(() => {});
      setSessionId(null);
    }
  }, [stopCamera, sessionId, frameCount, jointAngles]);

  // ── Handle File Upload ────────────────────────────────────────────────
  const handleFileUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

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
      video.oncanplay = () => {
        video.oncanplay = null;
        video.play().catch(() => {});
        startFromVideoElement();
        setUploadRunning(true);
      };
    }
  }, [isRunning, stopCamera, videoRef, analyzeImage, startFromVideoElement]);

  // ── Re-analyze uploaded file with current shot type ──────────────────
  const reanalyzeUpload = useCallback(() => {
    if (!uploadedFile) return;

    if (uploadedFile.type === 'image') {
      const img = new Image();
      img.onload = () => {
        videoDimsRef.current = { width: img.naturalWidth, height: img.naturalHeight };
        analyzeImage(img);
      };
      img.src = uploadedFile.url;
    } else {
      // Video: seek to start and restart the loop
      const video = videoRef.current;
      if (!video) return;
      stopCamera();
      video.currentTime = 0;
      video.oncanplay = () => {
        video.oncanplay = null;
        video.play().catch(() => {});
        startFromVideoElement();
        setUploadRunning(true);
      };
      // If video is already loaded, trigger canplay manually
      if (video.readyState >= 3) {
        video.dispatchEvent(new Event('canplay'));
      }
    }
  }, [uploadedFile, analyzeImage, videoRef, stopCamera, startFromVideoElement]);

  // ── Stop uploaded video analysis ──────────────────────────────────
  const stopUploadAnalysis = useCallback(() => {
    stopCamera();
    setUploadRunning(false);
  }, [stopCamera]);

  // ── Track Video Dimensions for Canvas Sizing ──────────────────────────
  const handleVideoMetadata = useCallback(() => {
    if (videoRef.current) {
      videoDimsRef.current = {
        width:  videoRef.current.videoWidth  || 640,
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
              <label className="source-btn" htmlFor="file-upload-input">
                📁 Upload Video / Photo
                <input
                  id="file-upload-input"
                  type="file"
                  accept="video/*,image/*"
                  style={{ display: 'none' }}
                  onChange={handleFileUpload}
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
                    disabled={!isModelReady || isRunning}
                    title={isRunning ? 'Stop webcam first' : 'Re-run analysis with current shot type'}
                  >
                    ⟳ Re-analyze
                  </button>
                )}
              </div>
            )}

            {/* Webcam stream toggle */}
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
          </div>

          {/* Status pill */}
          <div className="status-pill" style={{ '--status-color': status.color }}>
            <span className="status-dot" />
            <span className="status-label">{status.label}</span>
            {isRunning && <span className="status-frame-count">Frame {frameCount}</span>}
          </div>
        </header>

        {/* ── Main Layout ─────────────────────────────────────────────── */}
        <main className="dashboard-main">
          {/* ── Left: Video + Canvas Overlay ────────────────────────── */}
          <section className="video-panel glass-card" aria-label="Video feed with skeleton overlay">
            <div className="video-panel-header">
              <span className="panel-title">Live Feed</span>
              {isUploadVideoRunning && (
                <div className="live-badge" style={{ borderColor: 'rgba(0,230,118,0.3)' }}>
                  <div className="pulse-dot" />
                  <span>FILE</span>
                </div>
              )}
              {isRunning && !uploadRunning && (
                <div className="live-badge">
                  <div className="pulse-dot" />
                  <span>LIVE</span>
                </div>
              )}
            </div>

            <div className="video-wrapper">
              {/* Static image display (photo upload) */}
              {imageUrl ? (
                <img
                  ref={imgRef}
                  src={imageUrl}
                  alt="Uploaded photo for pose analysis"
                  style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                />
              ) : (
                /* Video element (webcam or video file) */
                <video
                  ref={videoRef}
                  id="stance-video"
                  className="video-element"
                  autoPlay
                  playsInline
                  muted
                  onLoadedMetadata={handleVideoMetadata}
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              )}

              {/* Canvas overlay — absolutely positioned over image/video */}
              <SkeletonOverlay
                landmarks={landmarks}
                jointAngles={jointAngles}
                width={videoDimsRef.current.width}
                height={videoDimsRef.current.height}
                showAngles={true}
                objectFit="contain"
              />

              {/* Empty state message */}
              {!isRunning && !imageUrl && landmarks.length === 0 && (
                <div className="video-placeholder">
                  <div className="placeholder-icon">🦴</div>
                  <p>Press <strong>Start Analysis</strong> to begin</p>
                  <p className="text-muted text-sm">Powered by MediaPipe · No server required</p>
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

          {/* ── Right: Metrics Panel ─────────────────────────────────── */}
          <aside className="metrics-panel">
            {/* Joint Angles Card */}
            <div className="glass-card metrics-card fade-in-up">
              <div className="metrics-header">
                <span className="panel-title">Joint Angles</span>
                <span className="badge badge-inactive">{shotType.replace(/_/g, ' ')}</span>
              </div>

              {jointAngles.length === 0 ? (
                <div className="metrics-empty">
                  <p className="text-muted text-sm">No pose data yet.</p>
                  <p className="text-muted text-sm">Start analysis to see joint metrics.</p>
                </div>
              ) : (
                <ul className="joint-list">
                  {jointAngles.map((ja) => {
                    const q = QUALITY_LABELS[ja.quality] || QUALITY_LABELS.UNCLASSIFIED;
                    return (
                      <li key={ja.jointName} className="joint-row">
                        <div className="joint-info">
                          <span className="joint-name">{ja.jointName.replace(/_/g, ' ')}</span>
                          <span className={`badge ${q.cls}`}>{q.label}</span>
                        </div>
                        <div className="joint-metrics">
                          <span className="joint-angle text-mono">
                            {ja.angleDegrees?.toFixed(1)}°
                          </span>
                          {ja.deviation > 0 && (
                            <span className="joint-deviation text-mono text-muted">
                              ±{ja.deviation?.toFixed(1)}°
                            </span>
                          )}
                        </div>
                        {/* Range bar */}
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
                  })}
                </ul>
              )}
            </div>

            {/* Session Summary Card */}
            <div className="glass-card metrics-card fade-in-up" style={{ animationDelay: '80ms' }}>
              <div className="metrics-header">
                <span className="panel-title">Session</span>
              </div>
              <div className="session-stats">
                <div className="stat-item">
                  <span className="stat-value text-mono">{frameCount}</span>
                  <span className="stat-label">Frames Analyzed</span>
                </div>
                <div className="stat-item">
                  <span className="stat-value text-mono">
                    {jointAngles.filter(j => j.quality === 'OPTIMAL').length}
                    <span className="text-muted"> / {jointAngles.length}</span>
                  </span>
                  <span className="stat-label">Joints Optimal</span>
                </div>
                <div className="stat-item">
                  <span className="stat-value text-mono" style={{ color: isRunning ? '#00e676' : '#90a4ae' }}>
                    {isRunning ? `${fps} fps` : 'Idle'}
                  </span>
                  <span className="stat-label">Inference FPS</span>
                </div>
              </div>
            </div>

            {/* Legend Card */}
            <div className="glass-card metrics-card fade-in-up" style={{ animationDelay: '160ms' }}>
              <div className="metrics-header">
                <span className="panel-title">Legend</span>
              </div>
              <ul className="legend-list">
                <li><span className="legend-dot" style={{ background: '#00e676' }} />Optimal — Within benchmark range</li>
                <li><span className="legend-dot" style={{ background: '#ffd600' }} />Warning — Moderate deviation</li>
                <li><span className="legend-dot" style={{ background: '#ff1744' }} />Critical — Significant deviation</li>
                <li><span className="legend-dot" style={{ background: '#90a4ae' }} />No benchmark for this joint</li>
              </ul>
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
  const pct   = (v) => `${((clamp(v) - DISPLAY_MIN) / range) * 100}%`;

  const colors = {
    OPTIMAL:      '#00e676',
    WARNING:      '#ffd600',
    CRITICAL:     '#ff1744',
    UNCLASSIFIED: '#90a4ae',
  };

  return (
    <div className="range-bar" role="meter" aria-valuenow={value} aria-valuemin={DISPLAY_MIN} aria-valuemax={DISPLAY_MAX}>
      {/* Optimal zone */}
      <div
        className="range-zone"
        style={{
          left:  pct(min),
          width: `${((clamp(max) - clamp(min)) / range) * 100}%`,
        }}
      />
      {/* Current angle marker */}
      <div
        className="range-marker"
        style={{
          left: pct(value),
          background: colors[quality] || colors.UNCLASSIFIED,
          boxShadow: `0 0 6px ${colors[quality] || colors.UNCLASSIFIED}`,
        }}
      />
    </div>
  );
}
