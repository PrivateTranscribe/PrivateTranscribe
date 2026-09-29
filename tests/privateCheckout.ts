import fs from "node:fs";
import path from "node:path";

// The backend (supabase/) and the legal texts live in the private
// PrivateTranscribe-workspace repo. Checks that compare the app with them run when
// that checkout sits next to this one, and are skipped everywhere else. The search
// walks up the folders, so a worktree inside the checkout finds the same sibling.
function candidateRoots(): string[] {
  const roots = [process.cwd()];
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    roots.push(path.join(path.dirname(dir), "PrivateTranscribe-workspace"));
    if (path.dirname(dir) === dir) return roots;
  }
}
const ROOTS = candidateRoots();

export function privateFile(...segments: string[]): string | null {
  for (const root of ROOTS) {
    const candidate = path.join(root, ...segments);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
