"use strict";

const assert = require("assert");

const { isSensitiveAppContext } = require("../src/helpers/activeWindowContext");

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`✓ ${name}\n`);
  } catch (err) {
    process.stderr.write(`✗ ${name}\n`);
    throw err;
  }
}

test("blocks common password managers by app/process name", () => {
  assert.strictEqual(isSensitiveAppContext({ appName: "1Password" }), true);
  assert.strictEqual(isSensitiveAppContext({ processName: "Bitwarden" }), true);
  assert.strictEqual(isSensitiveAppContext({ appClass: "KeePassXC" }), true);
  assert.strictEqual(isSensitiveAppContext({ appClass: "KeePass2" }), true);
  assert.strictEqual(isSensitiveAppContext({ processName: "Keeper" }), true);
  assert.strictEqual(isSensitiveAppContext({ appName: "RoboForm" }), true);
  assert.strictEqual(isSensitiveAppContext({ appName: "Enpass" }), true);
  assert.strictEqual(isSensitiveAppContext({ appName: "Passbolt" }), true);
});

test("blocks common Linux credential stores", () => {
  assert.strictEqual(isSensitiveAppContext({ appName: "Gnome Keyring" }), true);
  assert.strictEqual(isSensitiveAppContext({ processName: "seahorse" }), true);
  assert.strictEqual(isSensitiveAppContext({ appClass: "KWalletManager" }), true);
});

test("blocks Windows secure desktop surfaces by process name", () => {
  assert.strictEqual(isSensitiveAppContext({ processName: "CredentialUIBroker" }), true);
  assert.strictEqual(isSensitiveAppContext({ processName: "LogonUI" }), true);
  assert.strictEqual(isSensitiveAppContext({ processName: "LockApp" }), true);
});

test("blocks explicit password/credential prompt titles", () => {
  assert.strictEqual(isSensitiveAppContext({ windowTitle: "Enter password" }), true);
  assert.strictEqual(isSensitiveAppContext({ windowTitle: "Windows Security" }), true);
  assert.strictEqual(isSensitiveAppContext({ windowTitle: "User Account Control" }), true);
});

test("does not block common non-sensitive apps", () => {
  assert.strictEqual(isSensitiveAppContext({ appName: "Google Chrome" }), false);
  assert.strictEqual(isSensitiveAppContext({ processName: "Code" }), false);
  assert.strictEqual(isSensitiveAppContext({ appClass: "firefox" }), false);
  assert.strictEqual(isSensitiveAppContext({ windowTitle: "Slack | general" }), false);
});

process.stdout.write("All active window context tests passed.\n");
