/**
 * StanceAI — useDualCamera Hook
 * ================================
 * Enumerates all available video-input devices and exposes helpers
 * for managing two simultaneous camera selections.
 *
 * Usage:
 * ```jsx
 * const {
 *   deviceList,
 *   cam1Id, setCam1Id,
 *   cam2Id, setCam2Id,
 *   swapCameras,
 *   permissionGranted,
 *   requestPermission,
 * } = useDualCamera();
 * ```
 *
 * Notes:
 *  - Browsers only expose device labels AFTER at least one getUserMedia call
 *    (or when the site already has camera permission).
 *  - `requestPermission()` does a minimal getUserMedia to unlock labels, then
 *    immediately stops the temporary stream.
 *  - The hook itself does NOT open any camera stream — that is the
 *    responsibility of individual `usePoseDetection` instances.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Label shown when a camera device has no system label yet. */
const unlabelledName = (index) => `Camera ${index + 1}`;

/** Filter MediaDevices list to video inputs only and shape for UI. */
function parseVideoDevices(devices) {
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || unlabelledName(i),
    }));
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useDualCamera() {
  const [deviceList,        setDeviceList]        = useState([]); // { deviceId, label }[]
  const [cam1Id,            setCam1Id]            = useState(''); // '' = default system cam
  const [cam2Id,            setCam2Id]            = useState('');
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [permissionError,   setPermissionError]   = useState(null);

  // Track latest ids in a ref so refreshDevices callback doesn't go stale
  const cam1IdRef = useRef(cam1Id);
  const cam2IdRef = useRef(cam2Id);
  useEffect(() => { cam1IdRef.current = cam1Id; }, [cam1Id]);
  useEffect(() => { cam2IdRef.current = cam2Id; }, [cam2Id]);

  // ── Refresh the device list ──────────────────────────────────────────────
  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = parseVideoDevices(all);
      setDeviceList(cams);

      // Auto-assign on first load only (don't override user selections)
      if (cams.length >= 1 && !cam1IdRef.current) setCam1Id(cams[0].deviceId);
      if (cams.length >= 2 && !cam2IdRef.current) setCam2Id(cams[1].deviceId);
    } catch (err) {
      console.error('[useDualCamera] enumerateDevices failed:', err);
    }
  }, []);

  // ── Request camera permission (unlocks device labels) ───────────────────
  /**
   * Opens a brief getUserMedia to trigger the browser permission prompt.
   * Immediately stops the temporary stream after labels are obtained.
   */
  const requestPermission = useCallback(async () => {
    setPermissionError(null);
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tempStream.getTracks().forEach((t) => t.stop()); // release immediately
      setPermissionGranted(true);
      await refreshDevices();
    } catch (err) {
      console.error('[useDualCamera] Permission denied:', err);
      setPermissionError(
        err.name === 'NotAllowedError'
          ? 'Camera permission denied. Please allow access in your browser settings.'
          : `Camera error: ${err.message}`,
      );
    }
  }, [refreshDevices]);

  // ── Swap the two camera assignments ─────────────────────────────────────
  const swapCameras = useCallback(() => {
    setCam1Id((prev1) => {
      setCam2Id(prev1);
      return cam2IdRef.current;
    });
  }, []);

  // ── Listen for device changes (e.g. phone plugged in via USB) ───────────
  useEffect(() => {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
    };
  }, [refreshDevices]);

  // ── Initial enumeration (may have limited labels before permission) ──────
  useEffect(() => {
    refreshDevices();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived ──────────────────────────────────────────────────────────────
  const hasTwoCameras = deviceList.length >= 2;

  return {
    deviceList,
    cam1Id,      setCam1Id,
    cam2Id,      setCam2Id,
    swapCameras,
    hasTwoCameras,
    permissionGranted,
    permissionError,
    requestPermission,
    refreshDevices,
  };
}
