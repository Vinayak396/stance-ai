import { useEffect, useRef, useCallback, useReducer } from 'react';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws/stream';

// ─── State Shape ─────────────────────────────────────────────────────────────
const INITIAL_STATE = {
  connected: false,
  connecting: false,
  error: null,
  landmarks: [],
  jointAngles: [],
  annotatedFrameB64: null,
  frameCount: 0,
  lastReceivedAt: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'CONNECTING':
      return { ...state, connecting: true, error: null };
    case 'CONNECTED':
      return { ...state, connected: true, connecting: false, error: null };
    case 'DISCONNECTED':
      return { ...state, connected: false, connecting: false };
    case 'ERROR':
      return { ...state, error: action.payload, connecting: false };
    case 'POSE_DATA':
      return {
        ...state,
        landmarks: action.payload.landmarks || [],
        jointAngles: action.payload.joint_angles || [],
        annotatedFrameB64: action.payload.annotated_frame || null,
        frameCount: state.frameCount + 1,
        lastReceivedAt: Date.now(),
      };
    case 'RESET':
      return { ...INITIAL_STATE };
    default:
      return state;
  }
}

/**
 * usePoseStream — WebSocket hook for real-time pose streaming.
 *
 * Usage:
 * ```jsx
 * const { connected, landmarks, jointAngles, sendFrame, connect, disconnect } = usePoseStream();
 * ```
 *
 * - Call `connect()` to open the WebSocket.
 * - Call `sendFrame(base64JpegString, shotType)` to push a frame.
 * - Incoming results are available in `landmarks` and `jointAngles`.
 * - Call `disconnect()` to cleanly close the connection.
 *
 * @param {object} options
 * @param {boolean} options.autoConnect - Automatically open WS on mount (default: false)
 * @param {string}  options.shotType    - Default shot type for frames
 */
export function usePoseStream({ autoConnect = false, shotType: defaultShotType = 'COVER_DRIVE' } = {}) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  // ── Connect ────────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    dispatch({ type: 'CONNECTING' });

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[StanceAI WS] Connected to', WS_URL);
      dispatch({ type: 'CONNECTED' });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          console.warn('[StanceAI WS] Server error:', data.error);
          return;
        }
        if (data.success) {
          dispatch({ type: 'POSE_DATA', payload: data });
        }
      } catch (e) {
        console.error('[StanceAI WS] Failed to parse message:', e);
      }
    };

    ws.onerror = (err) => {
      console.error('[StanceAI WS] Error:', err);
      dispatch({ type: 'ERROR', payload: 'WebSocket connection error.' });
    };

    ws.onclose = (event) => {
      console.log(`[StanceAI WS] Disconnected (code=${event.code})`);
      dispatch({ type: 'DISCONNECTED' });
      wsRef.current = null;
    };
  }, []);

  // ── Disconnect ─────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close(1000, 'User requested disconnect');
      wsRef.current = null;
    }
    dispatch({ type: 'DISCONNECTED' });
  }, []);

  // ── Send Frame ─────────────────────────────────────────────────────────
  /**
   * Send a base64-encoded JPEG frame to the server for processing.
   *
   * @param {string} base64Jpeg - Base64-encoded JPEG string (no data URI prefix)
   * @param {string} shotType   - Override the shot type for this frame
   */
  const sendFrame = useCallback((base64Jpeg, shotType = defaultShotType) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('[StanceAI WS] Cannot send frame — not connected.');
      return;
    }
    wsRef.current.send(JSON.stringify({
      frame: base64Jpeg,
      shot_type: shotType,
    }));
  }, [defaultShotType]);

  // ── Capture Canvas Frame as Base64 ─────────────────────────────────────
  /**
   * Utility: Capture a video element frame as a base64 JPEG string.
   * Pass to sendFrame() on each animation tick.
   *
   * @param {HTMLVideoElement} videoEl
   * @param {HTMLCanvasElement} captureCanvas - Off-screen canvas for capture
   * @param {number} quality - JPEG quality (0–1)
   * @returns {string|null} base64 string or null if video not ready
   */
  const captureVideoFrame = useCallback((videoEl, captureCanvas, quality = 0.8) => {
    if (!videoEl || videoEl.readyState < 2) return null;

    captureCanvas.width  = videoEl.videoWidth  || 640;
    captureCanvas.height = videoEl.videoHeight || 480;

    const ctx = captureCanvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, captureCanvas.width, captureCanvas.height);

    // Return base64 without the data URI prefix
    const dataUrl = captureCanvas.toDataURL('image/jpeg', quality);
    return dataUrl.split(',')[1];
  }, []);

  // ── Auto-connect on mount ──────────────────────────────────────────────
  useEffect(() => {
    if (autoConnect) connect();
    return () => disconnect();
  }, [autoConnect, connect, disconnect]);

  return {
    ...state,
    connect,
    disconnect,
    sendFrame,
    captureVideoFrame,
  };
}
