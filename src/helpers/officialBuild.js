const fs = require("fs");
const path = require("path");

// Only the workflows that build what users receive set this field, through
// electron-builder's extraMetadata. A copy built from source lacks it, so it
// never checks for app updates or sends analytics.
const OFFICIAL_BUILD_FIELD = "privatetranscribeOfficialBuild";
// Lets tests exercise the update and consent code. Nothing in the app sets it.
const OFFICIAL_BUILD_OVERRIDE_ENV = "PRIVATETRANSCRIBE_OFFICIAL_BUILD";

function hasOfficialBuildFlag(packageJson) {
  const value = packageJson?.[OFFICIAL_BUILD_FIELD];
  return value === true || value === "true";
}

function readAppPackageJson() {
  try {
    const { app } = require("electron");
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function isOfficialBuild() {
  if (process.env[OFFICIAL_BUILD_OVERRIDE_ENV] === "1") {
    return true;
  }
  return hasOfficialBuildFlag(readAppPackageJson());
}

module.exports = {
  OFFICIAL_BUILD_FIELD,
  OFFICIAL_BUILD_OVERRIDE_ENV,
  hasOfficialBuildFlag,
  isOfficialBuild,
};
