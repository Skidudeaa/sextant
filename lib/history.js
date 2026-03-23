/**
 * Health history tracking for sparkline visualizations.
 * Stores timestamped snapshots in .planning/intel/history.json
 */

const fs = require("fs");
const path = require("path");

const MAX_SNAPSHOTS = 100;  // Keep last 100 snapshots
const MIN_INTERVAL_MS = 60000;  // Don't record more than once per minute

function historyPath(rootAbs) {
  return path.join(rootAbs, ".planning", "intel", "history.json");
}

/**
 * Load history from disk
 * @returns {{ snapshots: Array<{ts: number, resolutionPct: number, indexedFiles: number}> }}
 */
function loadHistory(rootAbs) {
  const p = historyPath(rootAbs);
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      if (data && Array.isArray(data.snapshots)) {
        return data;
      }
    }
  } catch {
    // Corrupted file, start fresh
  }
  return { snapshots: [] };
}

/**
 * Save history to disk
 */
function saveHistory(rootAbs, history) {
  const p = historyPath(rootAbs);
  const dir = path.dirname(p);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  // Prune to max snapshots
  if (history.snapshots.length > MAX_SNAPSHOTS) {
    history.snapshots = history.snapshots.slice(-MAX_SNAPSHOTS);
  }
  
  fs.writeFileSync(p, JSON.stringify(history, null, 2) + "\n", "utf8");
}

/**
 * Record a health snapshot
 * @param {string} rootAbs - Absolute path to repo root
 * @param {object} healthData - Health data from summary.health()
 */
function recordSnapshot(rootAbs, healthData) {
  const history = loadHistory(rootAbs);
  const now = Date.now();
  
  // Check minimum interval
  const lastTs = history.snapshots.length > 0 
    ? history.snapshots[history.snapshots.length - 1].ts 
    : 0;
  
  if (now - lastTs < MIN_INTERVAL_MS) {
    return; // Too soon, skip
  }
  
  const snapshot = {
    ts: now,
    resolutionPct: healthData.resolutionPct ?? null,
    indexedFiles: healthData.indexedFiles ?? null,
    localResolved: healthData.localResolved ?? null,
    localTotal: healthData.localTotal ?? null,
  };
  
  history.snapshots.push(snapshot);
  saveHistory(rootAbs, history);
}

/**
 * Get resolution % history for sparkline
 * @param {string} rootAbs
 * @param {number} count - Number of data points to return
 * @returns {number[]} Array of resolution percentages (oldest to newest)
 */
function getResolutionHistory(rootAbs, count = 20) {
  const history = loadHistory(rootAbs);
  const snapshots = history.snapshots.slice(-count);
  return snapshots.map(s => s.resolutionPct ?? 0);
}

/**
 * Get indexed file count history for sparkline
 * @param {string} rootAbs
 * @param {number} count
 * @returns {number[]}
 */
function getIndexedFilesHistory(rootAbs, count = 20) {
  const history = loadHistory(rootAbs);
  const snapshots = history.snapshots.slice(-count);
  return snapshots.map(s => s.indexedFiles ?? 0);
}

/**
 * Get history summary for display
 * @param {string} rootAbs
 * @returns {{ 
 *   resolutionTrend: number[], 
 *   filesTrend: number[], 
 *   firstTs: number|null, 
 *   lastTs: number|null,
 *   snapshotCount: number 
 * }}
 */
function getHistorySummary(rootAbs, count = 20) {
  const history = loadHistory(rootAbs);
  const snapshots = history.snapshots;
  
  if (snapshots.length === 0) {
    return {
      resolutionTrend: [],
      filesTrend: [],
      firstTs: null,
      lastTs: null,
      snapshotCount: 0,
    };
  }
  
  const recent = snapshots.slice(-count);
  
  return {
    resolutionTrend: recent.map(s => s.resolutionPct ?? 0),
    filesTrend: recent.map(s => s.indexedFiles ?? 0),
    firstTs: snapshots[0].ts,
    lastTs: snapshots[snapshots.length - 1].ts,
    snapshotCount: snapshots.length,
  };
}

/**
 * Clear history (for testing or reset)
 */
function clearHistory(rootAbs) {
  const p = historyPath(rootAbs);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

module.exports = {
  recordSnapshot,
  getResolutionHistory,
  getIndexedFilesHistory,
  getHistorySummary,
  loadHistory,
  clearHistory,
};
