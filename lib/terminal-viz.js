/**
 * Terminal visualization utilities for CLI output.
 * Zero external dependencies - uses ANSI escape codes directly.
 */

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  
  // Foreground
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  
  // Background
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
};

/**
 * Check if terminal supports colors
 */
function supportsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY;
}

const useColor = supportsColor();

/**
 * Wrap text in color codes (no-op if colors disabled)
 */
function c(text, ...codes) {
  if (!useColor) return text;
  return codes.join("") + text + colors.reset;
}

/**
 * Horizontal bar chart for percentages
 * @param {number} value - Value 0-100
 * @param {number} width - Total width in characters (default 20)
 * @param {object} opts - { showPercent: bool, thresholds: {warn, danger} }
 */
function bar(value, width = 20, opts = {}) {
  const { showPercent = true, thresholds = { warn: 90, danger: 80 } } = opts;
  const pct = Math.max(0, Math.min(100, value));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  
  // Choose color based on thresholds (inverted - lower is worse)
  let barColor = colors.green;
  if (pct < thresholds.danger) barColor = colors.red;
  else if (pct < thresholds.warn) barColor = colors.yellow;
  
  const filledChars = "█".repeat(filled);
  const emptyChars = "░".repeat(empty);
  
  let result = useColor 
    ? barColor + filledChars + colors.gray + emptyChars + colors.reset
    : filledChars + emptyChars;
  
  if (showPercent) {
    result += ` ${pct}%`;
  }
  
  return result;
}

/**
 * Sparkline from array of values
 * Uses Unicode block characters for granularity
 * @param {number[]} values - Array of numeric values
 * @param {object} opts - { width: number, min: number, max: number }
 */
function sparkline(values, opts = {}) {
  if (!values || values.length === 0) return "";
  
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const { width = values.length } = opts;
  
  // Resample if needed
  let data = values;
  if (width < values.length) {
    data = resample(values, width);
  }
  
  const min = opts.min ?? Math.min(...data);
  const max = opts.max ?? Math.max(...data);
  const range = max - min || 1;
  
  let result = "";
  for (const v of data) {
    const normalized = (v - min) / range;
    const idx = Math.min(chars.length - 1, Math.floor(normalized * chars.length));
    result += chars[idx];
  }
  
  return c(result, colors.cyan);
}

/**
 * Resample array to target length (simple averaging)
 */
function resample(arr, targetLen) {
  if (arr.length <= targetLen) return arr;
  const result = [];
  const step = arr.length / targetLen;
  for (let i = 0; i < targetLen; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    const slice = arr.slice(start, end);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    result.push(avg);
  }
  return result;
}

/**
 * Status indicator with icon and color
 * @param {"ok"|"warn"|"error"|"info"} status
 * @param {string} text
 */
function status(type, text) {
  const icons = {
    ok: { icon: "✓", color: colors.green },
    warn: { icon: "⚠", color: colors.yellow },
    error: { icon: "✗", color: colors.red },
    info: { icon: "●", color: colors.blue },
  };
  
  const { icon, color } = icons[type] || icons.info;
  
  if (!useColor) return `${icon} ${text}`;
  return `${color}${icon}${colors.reset} ${text}`;
}

/**
 * Labeled metric with value and optional bar
 * @param {string} label
 * @param {string|number} value
 * @param {object} opts - { bar: bool, barValue: number, width: number }
 */
function metric(label, value, opts = {}) {
  const { showBar = false, barValue = 0, barWidth = 15, labelWidth = 18 } = opts;
  const paddedLabel = label.padEnd(labelWidth);
  
  let line = `  ${c(paddedLabel, colors.dim)}${value}`;
  
  if (showBar && typeof barValue === "number") {
    line += `  ${bar(barValue, barWidth, { showPercent: false })}`;
  }
  
  return line;
}

/**
 * Section header
 */
function header(text) {
  return c(`\n## ${text}`, colors.bold, colors.cyan);
}

/**
 * Dim secondary text
 */
function dim(text) {
  return c(text, colors.dim);
}

/**
 * Box around content
 * @param {string[]} lines
 * @param {object} opts - { title: string, padding: number }
 */
function box(lines, opts = {}) {
  const { title = "", padding = 1, rounded = false, dividerAfter = -1 } = opts;
  const tl = rounded ? "╭" : "┌";
  const tr = rounded ? "╮" : "┐";
  const bl = rounded ? "╰" : "└";
  const br = rounded ? "╯" : "┘";

  const maxLen = Math.max(...lines.map(stripAnsi).map(l => l.length), stripAnsi(title).length);
  const width = maxLen + padding * 2;

  const top = title
    ? `${tl}─ ${title} ${"─".repeat(Math.max(0, width - stripAnsi(title).length - 4))}${tr}`
    : `${tl}${"─".repeat(width)}${tr}`;
  const bottom = `${bl}${"─".repeat(width)}${br}`;

  const padded = lines.map((l, i) => {
    const visible = stripAnsi(l).length;
    const rightPad = width - visible - padding;
    let row = `│${" ".repeat(padding)}${l}${" ".repeat(Math.max(0, rightPad))}│`;
    if (i === dividerAfter) {
      row += `\n├${"─".repeat(width)}┤`;
    }
    return row;
  });

  return [top, ...padded, bottom].join("\n");
}

/**
 * Strip ANSI codes for length calculation
 */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Format age in human-readable form
 */
function formatAge(seconds) {
  if (seconds == null) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

/**
 * Colorize age based on staleness
 */
function ageStatus(seconds, thresholds = { warn: 300, danger: 3600 }) {
  const formatted = formatAge(seconds);
  if (seconds == null) return dim(formatted);
  if (seconds > thresholds.danger) return c(formatted, colors.red);
  if (seconds > thresholds.warn) return c(formatted, colors.yellow);
  return c(formatted, colors.green);
}

module.exports = {
  colors,
  c,
  bar,
  sparkline,
  status,
  metric,
  header,
  dim,
  box,
  formatAge,
  ageStatus,
};
