#!/usr/bin/env node
// Fails a release whose packaged app lacks the official-build flag. Without it the
// app never checks for updates, so everyone who installs that release stays on it.
// Usage: node scripts/verify-official-build.js <path to app.asar>
const asar = require("@electron/asar");
const { OFFICIAL_BUILD_FIELD, hasOfficialBuildFlag } = require("../src/helpers/officialBuild");

const asarPath = process.argv[2];
if (!asarPath) {
  console.error("Usage: node scripts/verify-official-build.js <path to app.asar>");
  process.exit(2);
}

const packageJson = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
if (!hasOfficialBuildFlag(packageJson)) {
  console.error(`${asarPath} has no ${OFFICIAL_BUILD_FIELD} flag in its package.json.`);
  process.exit(1);
}
console.log(`${asarPath} is marked as an official build.`);
