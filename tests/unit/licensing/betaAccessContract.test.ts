import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("paid Pro and tester beta access contract", () => {
  it("marks approved tester licenses with beta access", () => {
    const source = readSource("supabase/functions/tester-signup/index.ts");
    expect(source).toContain("beta_access: true");
  });

  it("returns beta access in the signed activation entitlement", () => {
    const source = readSource("supabase/functions/activate/index.ts");
    expect(source).toContain("betaAccess: license.beta_access === true");
  });

  it("enforces tester access in beta feature runtime paths", () => {
    const audioHook = readSource("src/hooks/useAudioRecording.js");
    const audioManager = readSource("src/helpers/audioManager.js");
    const contextPipeline = readSource("src/helpers/contextPipeline.js");

    expect(audioHook).toContain('isBetaFeatureUnlocked("correction-memory")');
    expect(audioManager).toContain('this._checkBetaFeatureAccess("ai-enhancement")');
    expect(contextPipeline).toContain("hasTesterAccess()");

    // The Action Engine matters most here. Its other surfaces need the user to
    // open a page that is itself gated, but this one fires off the end of every
    // dictation without anyone visiting it, so losing the check would run voice
    // commands for people who never had access.
    expect(audioHook).toContain('isBetaFeatureUnlocked("action-engine")');
  });

  it("does not pretend the main process can enforce entitlement", () => {
    // The Action Engine IPC handlers are deliberately not gated in the main
    // process. Entitlement lives in the renderer — localStorage plus a token
    // LicensingService verifies — and the main process has no independent copy
    // of it, so any gate there would have to ask the renderer, which is the
    // thing a devtools user would be tampering with in the first place. It
    // would be theatre, and it would cost an offline-first app a round trip.
    //
    // The real gates are the renderer paths asserted above. If main-process
    // enforcement is ever genuinely needed it has to come from server-side
    // verification at execution time, which is a different design decision and
    // breaks offline use.
    const handlers = readSource("src/helpers/ipcHandlers.js");
    expect(handlers).toContain('ipcMain.handle("action-engine-execute"');
    expect(handlers).not.toContain("hasTesterAccess");
  });

  it("keeps ordinary paid licenses on the default non-tester entitlement", () => {
    const webhook = readSource("supabase/functions/stripe-webhook/handler.ts");
    const manualGenerator = readSource("scripts/generate-license.js");
    expect(webhook).toContain("beta_access: false");
    expect(manualGenerator).toContain("beta_access: false");
  });

  it("migrates the existing licenses table and preserves approved testers", () => {
    const source = readSource("supabase/migrations/202608080001_add_license_beta_access.sql");
    expect(source).toContain("ALTER TABLE public.licenses");
    expect(source).toContain("ADD COLUMN IF NOT EXISTS beta_access");
    expect(source).toContain("SET beta_access = TRUE");
    expect(source).toContain("testers.approval_status = 'approved'");
  });

  it("deploys functions only after the database migration workflow succeeds", () => {
    const migrations = readSource(".github/workflows/deploy-supabase.yml");
    const functions = readSource(".github/workflows/deploy-supabase-functions.yml");
    expect(migrations).toContain('"supabase/functions/**"');
    expect(functions).toContain('workflows: ["Deploy Database Migrations"]');
    expect(functions).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(functions).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
    expect(migrations).not.toContain("Dry-run only");
    expect(functions).toContain("validate-creator-code stripe-webhook");
    expect(functions).toContain("LICENSE_SIGNING_SECRET: ${{ secrets.LICENSE_SIGNING_SECRET }}");
    expect(functions).toContain(
      'supabase secrets set LICENSE_SIGNING_SECRET="$LICENSE_SIGNING_SECRET"'
    );
  });

  it("gates tester-only UI reads and Action Engine operations", () => {
    const correctionPage = readSource("src/components/pages/CorrectionMemoryPage.tsx");
    const settings = readSource("src/components/SettingsPage.tsx");
    const actionHook = readSource("src/hooks/useActionEngine.ts");
    const actionPage = readSource("src/components/pages/ActionEnginePage.tsx");

    expect(correctionPage).toContain("if (!isUnlocked)");
    expect(correctionPage).toContain("if (!isUnlocked) return;");
    // Settings no longer reads correction memory at all; the page owns it.
    expect(settings).not.toContain("getCorrectionMemory");
    expect(actionHook).toContain("export function useActionEngine(isUnlocked = false)");
    expect(actionHook).toContain("if (!isUnlocked) return null;");
    expect(actionHook).toContain('error: "Approved tester access required."');
    expect(actionPage).toContain("useActionEngine(isUnlocked)");
  });

  it("exposes only the explicitly confirmed correction write path", () => {
    const preload = readSource("preload.js");
    const ipcHandlers = readSource("src/helpers/ipcHandlers.js");
    const electronTypes = readSource("src/types/electron.ts");

    expect(preload).toContain("confirmCorrection:");
    expect(ipcHandlers).toContain('ipcMain.handle("db-confirm-correction"');
    expect(preload).not.toContain("upsertCorrection:");
    expect(ipcHandlers).not.toContain('ipcMain.handle("db-upsert-correction"');
    expect(electronTypes).not.toContain("upsertCorrection:");
  });

  it("does not tell users that paid Pro unlocks tester-only screens", () => {
    const correctionMemory = readSource("src/components/pages/CorrectionMemoryPage.tsx");
    const actionEngine = readSource("src/components/pages/ActionEnginePage.tsx");
    expect(correctionMemory.replace(/\s+/g, " ")).toContain(
      "This beta requires approved tester access."
    );
    expect(correctionMemory).not.toContain("Unlock it with Pro");
    expect(actionEngine).toContain("This beta requires approved tester access.");
    expect(actionEngine).not.toContain("Get it with Pro");

    for (const source of [
      correctionMemory,
      actionEngine,
      readSource("src/components/ProSettingsSection.tsx"),
      readSource("src/components/SettingsPage.tsx"),
    ]) {
      expect(source).not.toMatch(/Tester beta|Approved tester beta/);
    }
  });
});
