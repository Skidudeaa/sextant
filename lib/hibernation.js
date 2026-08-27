"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function markerPath(env = process.env) {
  if (env.SEXTANT_HIBERNATION_MARKER) {
    return path.resolve(env.SEXTANT_HIBERNATION_MARKER);
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "sextant", "hibernating");
}

function isHibernating(env = process.env) {
  try {
    return fs.existsSync(markerPath(env));
  } catch {
    return false;
  }
}

module.exports = { isHibernating, markerPath };
