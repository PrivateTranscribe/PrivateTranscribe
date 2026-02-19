const path = require("path");
const { existsSync } = require("fs");
const { execFileSync } = require("child_process");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const appInfo = context.packager.appInfo;
  const productFilename = appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const projectDir = context.packager.projectDir;
  const iconPath = path.join(projectDir, "src", "assets", "icon.ico");
  const rceditPath = path.join(projectDir, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");

  if (!existsSync(exePath)) {
    throw new Error(`[after-pack-win] Executable not found: ${exePath}`);
  }
  if (!existsSync(iconPath)) {
    throw new Error(`[after-pack-win] Icon not found: ${iconPath}`);
  }
  if (!existsSync(rceditPath)) {
    throw new Error(`[after-pack-win] rcedit not found: ${rceditPath}`);
  }

  const fileVersion = appInfo.shortVersion || appInfo.buildVersion || appInfo.version;
  const productVersion = appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm();
  const originalFilename = `${productFilename}.exe`;

  const args = [
    exePath,
    "--set-icon",
    iconPath,
    "--set-version-string",
    "FileDescription",
    appInfo.productName,
    "--set-version-string",
    "ProductName",
    appInfo.productName,
    "--set-version-string",
    "InternalName",
    productFilename,
    "--set-version-string",
    "OriginalFilename",
    originalFilename,
    "--set-version-string",
    "AppUserModelID",
    appInfo.id,
    "--set-file-version",
    fileVersion,
    "--set-product-version",
    productVersion,
  ];

  if (appInfo.companyName) {
    args.push("--set-version-string", "CompanyName", appInfo.companyName);
  }
  if (appInfo.copyright) {
    args.push("--set-version-string", "LegalCopyright", appInfo.copyright);
  }

  execFileSync(rceditPath, args, { stdio: "inherit" });
  console.log(`[after-pack-win] Updated Windows metadata for ${originalFilename}`);
};
