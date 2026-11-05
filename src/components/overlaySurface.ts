import type { CSSProperties } from "react";

/**
 * The material and row shape every surface of the dictation overlay shares:
 * the Converse and Read Aloud capsules in App.jsx and the narrator's voice
 * questions (NarratorQuestionRows.tsx). App.jsx holds the geometry rule they
 * all follow; this is the part more than one file draws with.
 */

/**
 * The dictation button's radius, and therefore every radius in the overlay.
 * CSS clamps a corner to half the box, so one number gives a 44px button a
 * circle, a 32px status row a pill, and the taller player panel corners that
 * are exactly the button's arc. One rule, the whole family.
 */
export const OVERLAY_RADIUS = 22;

/**
 * Vertical padding of a status row. With a 12px line this is a 30px capsule,
 * against the 49px full-width row before - the "way smaller" Kristian asked
 * for on 2026-09-02.
 */
export const OVERLAY_STATUS_PAD_Y = 8;

/** A status row's one line: the status word, then anything after it in a quieter tone. */
export const OVERLAY_STATUS_TEXT_CLASS = "text-[12px] font-medium leading-none text-white/90";
export const OVERLAY_STATUS_DETAIL_CLASS = "text-[12px] leading-none tabular-nums text-white/60";

/**
 * The material every row and the command menu are made of: `--color-muted` at
 * 96%, a hairline white border, the same blur and the same shadow, so they are
 * recognisably the same surface caught in different states. The dictation
 * button deliberately sits outside this - see getMicButtonStyles.
 */
export const OVERLAY_SURFACE_CLASS =
  "border border-white/12 bg-muted/96 text-white shadow-[0_6px_18px_rgba(0,0,0,0.32)] backdrop-blur-xl";

/**
 * One entrance for every surface, growing from the anchor. Rows and the menu
 * both use it, so opening the menu and starting a read are the same gesture.
 */
export const OVERLAY_SURFACE_ANIMATION = "overlay-surface-in 180ms cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * The style a row carries. `status` rows hug their content and sit centred in
 * the column; everything else stretches to the column width.
 */
export function overlayRowStyle({
  interactive,
  status = false,
}: {
  interactive: boolean;
  status?: boolean;
}): CSSProperties {
  return {
    borderRadius: OVERLAY_RADIUS,
    paddingTop: status ? OVERLAY_STATUS_PAD_Y : undefined,
    paddingBottom: status ? OVERLAY_STATUS_PAD_Y : undefined,
    alignSelf: status ? "center" : "stretch",
    maxWidth: "100%",
    transformOrigin: "bottom center",
    animation: OVERLAY_SURFACE_ANIMATION,
    pointerEvents: interactive ? "auto" : "none",
  };
}

/**
 * The live marker in front of every status word - the one place a row uses
 * colour. Lit while something is audibly happening (speaking, listening,
 * reading), pulsing while the user is waiting on the machine (thinking,
 * preparing), dim otherwise. The same dot on the Converse capsule and the
 * Read Aloud panel is what makes them one family across two shapes.
 */
export function liveDotStyle({
  live,
  pulse,
  warn = false,
}: {
  live: boolean;
  pulse: boolean;
  warn?: boolean;
}): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: 3,
    flexShrink: 0,
    backgroundColor: warn
      ? "var(--color-warning)"
      : live || pulse
        ? "var(--color-primary)"
        : "rgba(255,255,255,0.4)",
    animation: pulse ? "overlay-dot-pulse 1.6s ease-in-out infinite" : undefined,
  };
}
