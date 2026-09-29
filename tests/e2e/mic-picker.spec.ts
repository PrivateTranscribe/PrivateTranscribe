import { expect, test, type Page } from "./fixtures/electron-app";

/**
 * Choosing a microphone used to mean finding "Prefer Built-in Microphone" in
 * General and turning it OFF before any device list appeared. Someone whose
 * dictation has just gone silent goes to Permissions, finds two permission
 * cards, and leaves no better off.
 *
 * The picker now sits beside the microphone permission, names the device
 * dictation will actually open, and can prove it hears you. These specs drive
 * the real window, because "can I find and change my microphone" is a thing you
 * look at rather than assert about state.
 */

const openMicrophoneSettings = async (controlPanel: Page) => {
  await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
  await controlPanel
    .getByRole("button", { name: "Microphone & Permissions", exact: true })
    .click();
  await expect(controlPanel.locator('[data-settings-label="Microphone"]')).toBeVisible();
};

test.describe("microphone picker in settings", () => {
  test("sits under the permission cards, already showing the device in use", async ({
    controlPanel,
  }) => {
    await openMicrophoneSettings(controlPanel);

    const row = controlPanel.locator('[data-settings-label="Microphone"]');
    await expect(row).toContainText("Automatic prefers a built-in mic");
    // The permission and the device live on one screen now.
    await expect(
      controlPanel.getByText("Required for voice recording and dictation", { exact: true })
    ).toBeVisible();
    await expect(row.getByRole("combobox")).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/mic-picker-settings.png",
      fullPage: true,
    });
  });

  test("lists the machine's inputs by name without a toggle in the way", async ({
    controlPanel,
  }) => {
    await openMicrophoneSettings(controlPanel);

    await controlPanel
      .locator('[data-settings-label="Microphone"]')
      .getByRole("combobox")
      .click();

    const options = controlPanel.getByRole("option");
    await expect(options.filter({ hasText: "Automatic (prefer built-in)" })).toBeVisible();
    await expect(options.filter({ hasText: "System default" })).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/mic-picker-open.png",
      fullPage: true,
    });
  });

  test("remembers a specific device for the next dictation", async ({ controlPanel }) => {
    await openMicrophoneSettings(controlPanel);

    const picker = controlPanel.locator('[data-settings-label="Microphone"]');
    await picker.getByRole("combobox").click();

    // The last option is a real input on this machine, whatever it is called.
    const deviceOptions = controlPanel.getByRole("option");
    const count = await deviceOptions.count();
    test.skip(count < 3, "This machine reports no audio input devices");
    const chosen = deviceOptions.nth(count - 1);
    const chosenName = (await chosen.textContent())?.trim() ?? "";
    await chosen.click();

    // Recording reads these two keys, so this is the setting actually changing.
    const stored = await controlPanel.evaluate(() => ({
      preferBuiltInMic: localStorage.getItem("preferBuiltInMic"),
      selectedMicDeviceId: localStorage.getItem("selectedMicDeviceId"),
    }));
    expect(stored.preferBuiltInMic).toBe("false");
    expect(stored.selectedMicDeviceId).toBeTruthy();

    // And the hint names it back, so the choice is visible without reopening.
    await expect(picker).toContainText("Dictation uses:");
    expect(chosenName.length).toBeGreaterThan(0);

    await controlPanel.screenshot({
      path: "test-results/e2e/mic-picker-chosen.png",
      fullPage: true,
    });
  });

  test("says whether the chosen microphone actually hears anything", async ({ controlPanel }) => {
    await openMicrophoneSettings(controlPanel);

    const picker = controlPanel.locator('[data-settings-label="Microphone"]');
    await picker.getByRole("button", { name: "Test microphone" }).click();
    await expect(picker.getByRole("button", { name: "Listening..." })).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/mic-picker-listening.png",
      fullPage: true,
    });

    // A silent room is a valid outcome and reports as one; what must not happen
    // is a test that ends with no verdict at all.
    await expect(picker).toContainText(/Heard you on |No sound came through |could not open/, {
      timeout: 15000,
    });

    await controlPanel.screenshot({
      path: "test-results/e2e/mic-picker-result.png",
      fullPage: true,
    });
  });
});

test.describe("microphone picker during onboarding", () => {
  test.use({ completeOnboarding: false });

  test("is offered on the permissions step, before the first dictation", async ({
    controlPanel,
  }) => {
    await controlPanel.evaluate(() => {
      localStorage.removeItem("onboardingCompleted");
      localStorage.setItem("onboardingCurrentStep", "3");
    });
    await controlPanel.reload({ waitUntil: "domcontentloaded" });

    await expect(controlPanel.getByRole("heading", { name: "Permissions" })).toBeVisible();
    await expect(controlPanel.getByRole("button", { name: "Test microphone" })).toBeVisible();
    await expect(controlPanel.getByRole("combobox")).toBeVisible();

    await controlPanel.screenshot({
      path: "test-results/e2e/mic-picker-onboarding.png",
      fullPage: true,
    });
  });
});
