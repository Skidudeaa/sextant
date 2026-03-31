"use strict";

// WHY: Single source of truth for all numeric scoring weights used across both
// retrieval paths (retrieve.js full pipeline and graph-retrieve.js fast hook path).
// Prevents silent divergence where the same concept uses different numbers in
// different modules — the root cause of the 100x fan-in mismatch bug.

// --- Fan-in ---
// Coefficient in Math.min(FAN_IN_CAP_FRACTION, Math.log1p(fanIn) * FAN_IN_MULTIPLIER)
const FAN_IN_MULTIPLIER = 0.02;
const FAN_IN_CAP_FRACTION = 0.15; // maximum fan-in contribution as fraction of base score

// --- Graph-based boosts (fraction of base score) ---
const HOTSPOT_BOOST = 0.15;
const ENTRY_POINT_BOOST = 0.10;

// --- Definition-site scoring ---
// TRADEOFF: def_site_priority and exact_symbol stack to +65% on definition lines.
// This is intentional — the combined boost must overcome fan-in promotion on hub
// files. The +40% alone was insufficient (MRR dropped on sym-002, path-001, path-002).
const DEF_SITE_PRIORITY = 0.25;   // retrieve.js: definition line matching query symbol
const EXACT_SYMBOL_BOOST = 0.40;  // scoring.js: exact symbol name match

// --- Fan-in suppression ---
// When a definition-site match exists, halve fan-in boost for non-definition files.
const FAN_IN_SUPPRESSION = 0.50;

// --- Line-level signals (fraction of base score) ---
const EXPORT_LINE_BOOST = 0.05;
const DEF_LINE_BOOST = 0.03;
const EXPORT_MATCH_BOOST = 0.10;
const SYMBOL_CONTAINS_QUERY_BOOST = 0.12;
const PYTHON_PUBLIC_BOOST = 0.08;
const DOCSTRING_MATCH_BOOST = 0.05;

// --- Penalties (fraction of base score) ---
const TEST_PENALTY = 0.25;
const VENDOR_PENALTY = 0.50;
const DOC_PENALTY = 0.40;
const NOISE_HIGH_PENALTY = 0.15; // noise ratio > 0.7
const NOISE_MID_PENALTY = 0.08;  // noise ratio > 0.5

// --- graph-retrieve.js base scores (absolute points) ---
// WHY: These are the starting scores before fan-in is applied as a percentage.
// exported_symbol is highest because the exports table directly encodes the
// definition site (re-exports live in a separate table).
const GR_EXPORTED_SYMBOL = 100;
const GR_REEXPORT_CHAIN = 80;
const GR_PATH_MATCH = 60;

// --- Hit type identifiers ---
const HIT_EXPORTED_SYMBOL = "exported_symbol";
const HIT_REEXPORT_CHAIN = "reexport_chain";
const HIT_PATH_MATCH = "path_match";

module.exports = {
  FAN_IN_MULTIPLIER,
  FAN_IN_CAP_FRACTION,
  HOTSPOT_BOOST,
  ENTRY_POINT_BOOST,
  DEF_SITE_PRIORITY,
  EXACT_SYMBOL_BOOST,
  FAN_IN_SUPPRESSION,
  EXPORT_LINE_BOOST,
  DEF_LINE_BOOST,
  EXPORT_MATCH_BOOST,
  SYMBOL_CONTAINS_QUERY_BOOST,
  PYTHON_PUBLIC_BOOST,
  DOCSTRING_MATCH_BOOST,
  TEST_PENALTY,
  VENDOR_PENALTY,
  DOC_PENALTY,
  NOISE_HIGH_PENALTY,
  NOISE_MID_PENALTY,
  GR_EXPORTED_SYMBOL,
  GR_REEXPORT_CHAIN,
  GR_PATH_MATCH,
  HIT_EXPORTED_SYMBOL,
  HIT_REEXPORT_CHAIN,
  HIT_PATH_MATCH,
};
