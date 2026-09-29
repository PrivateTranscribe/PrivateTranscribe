import fs from "node:fs";
import path from "node:path";

// The backend (supabase/) and the legal texts live in the private
// PrivateTranscribe-workspace repo. Checks that compare the app with them run when
// that checkout sits next to this one, and are skipped everywhere else.
const ROOTS = [process.cwd(), path.resolve(process.cwd(), "..", "PrivateTranscribe-workspace")];

export function privateFile(...segments: string[]): string | null {
  for (const root of ROOTS) {
    const candidate = path.join(root, ...segments);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
