/**
 * useSingleCameraMetrics
 * =======================
 * Compositing hook for single-camera 3D analysis.
 *
 * Given the landmarks / worldLandmarks emitted by usePoseDetection, it
 * computes the full merged analysis that previously required two cameras:
 *
 *   frontAngles  -- 3D joint angles (FRONT source)   via worldLandmarks
 *   sideMetrics  -- 3D footwork + blind-spot metrics (SIDE source) via worldLandmarks
 *   mergedAngles -- [...frontAngles, ...sideMetrics]
 *
 * Falls back to 2D-only front angles if worldLandmarks are not available.
 */

import { useMemo } from 'react';
import {
  computeJointAngles,
  computeJointAngles3D,
  computeSideViewMetrics3D,
} from '../lib/biomechanics.js';

/**
 * @param {object}   options
 * @param {Array}    options.landmarks        - 2D screen landmarks from usePoseDetection
 * @param {Array}    options.worldLandmarks   - 3D metric landmarks from usePoseDetection
 * @param {string}   options.shotType
 * @param {string}   [options.handedness='RHB']
 * @param {object}   [options.dbBenchmarks=null]
 */
export function useSingleCameraMetrics({
  landmarks      = [],
  worldLandmarks = [],
  shotType       = 'COVER_DRIVE',
  handedness     = 'RHB',
  dbBenchmarks   = null,
}) {
  return useMemo(() => {
    const has3D = Array.isArray(worldLandmarks) && worldLandmarks.length >= 33;

    // Front-camera joint angles (3D preferred, 2D fallback)
    const frontAngles = has3D
      ? computeJointAngles3D(worldLandmarks, shotType, dbBenchmarks)
      : (landmarks.length > 0 ? computeJointAngles(landmarks, shotType, dbBenchmarks) : []);

    // Side-view metrics (stride, weight transfer, elbow tuck, etc.)
    // Only available when worldLandmarks are present.
    const sideMetrics = has3D
      ? computeSideViewMetrics3D(worldLandmarks, shotType, handedness, dbBenchmarks)
      : [];

    return {
      frontAngles,
      sideMetrics,
      mergedAngles: [...frontAngles, ...sideMetrics],
      has3D,
    };
  }, [landmarks, worldLandmarks, shotType, handedness, dbBenchmarks]);
}
