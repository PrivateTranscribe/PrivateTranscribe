# PrivateTranscribe Design Taste Guide

Use this guide when changing product-facing UI, marketing UI, onboarding, empty states, or settings copy.

The goal is not to make PrivateTranscribe flashy. The goal is to avoid generic AI-app UI and make the product feel calm, private, useful, and trustworthy.

## Design resources to use

### 1. Emil Kowalski / animations.dev

Use for motion taste and interaction polish.

- Site: `https://emilkowal.ski`
- Motion reference: `https://animations.dev`

Apply only after the static layout works. Motion should clarify state changes, not decorate them.

Good uses:

- Settings toggles that confirm a change happened
- Startup/update/permission status transitions
- Recording state changes
- Download/progress feedback

Avoid:

- Big landing-page-style motion inside dense settings screens
- Animation that slows down dictation or makes the app feel less private/professional
- Adding motion before copy, hierarchy, and state clarity are solved

### 2. Impeccable

Use for better design vocabulary when prompting Claude/Codex/Atlas.

- Site: `https://impeccable.dev`
- Reel install command seen: `npx skills add pbakus/impeccable`

Do not add a dependency just to use it. Prefer using the vocabulary and critique style from the resource.

Prompt pattern:

> Review this UI for visual hierarchy, spacing rhythm, information scent, affordance clarity, copy specificity, empty/loading/error states, and whether it looks like a generic AI SaaS page. Suggest the smallest concrete changes.

### 3. Taste Skill

Use as a critique checklist for AI-generated UI.

- Site: `https://tasteskill.dev`

Treat it as review guidance, not a product dependency.

Ask:

- Does this screen look like any other AI wrapper?
- Is the main action obvious within 3 seconds?
- Is the copy specific to PrivateTranscribe and local/private dictation?
- Are states explicit: enabled/disabled, installed/missing, working/broken, dev/prod caveat?
- Is there one clear next action instead of multiple equal-weight buttons?

## PrivateTranscribe design principles

### 1. Calm operator UI

PrivateTranscribe is a private dictation tool, not a hype product.

Prefer:

- calm confidence
- clear status
- fewer choices per screen
- direct copy
- small confirmations

Avoid:

- generic gradient cards
- vague AI buzzwords
- excessive glassmorphism
- motivational copy
- overloaded settings rows

### 2. Make system state visible

Settings and setup screens should answer:

- What is the current state?
- Is it working on this machine?
- What happens if I toggle this?
- What do I do if it is broken?

Example for Startup:

- Bad: `Start on boot`
- Better: `Start PrivateTranscribe when I log in`
- Useful helper: `Runs in the background so your hotkey is ready after restart.`
- Dev caveat when relevant: `Developer builds can behave differently from the installed app.`
- Repair affordance when relevant: `Repair startup registration`

### 3. Specific copy beats generic polish

Replace vague copy with product-specific copy.

| Generic               | Better                                                               |
| --------------------- | -------------------------------------------------------------------- |
| `AI-powered workflow` | `Clean up dictated text before it is pasted`                         |
| `Configure settings`  | `Choose how PrivateTranscribe records, transcribes, and pastes text` |
| `Enable feature`      | `Start PrivateTranscribe when I log in`                              |
| `Processing...`       | `Transcribing locally...`                                            |

### 4. Use motion sparingly

Motion is allowed when it helps users understand state.

Good:

- subtle fade/slide between status states
- progress feedback for downloads and model setup
- recording pulse that communicates listening state

Bad:

- decorative bouncing cards
- motion that distracts during dictation
- animations on every settings interaction

## One control, one component

Two controls that do the same kind of job must never look different. If a screen needs a
dropdown, a button, a toggle, or an input, reach for the existing primitive in
`src/components/ui/` instead of hand-rolling one.

Rules:

- Never write a native `<select>`. Use `Select` from `src/components/ui/select.tsx`.
  ESLint blocks this (`no-restricted-syntax` in `src/eslint.config.js`).
- Dropdown look lives in `src/components/ui/selectStyles.ts`. Both the Radix `Select`
  and the bespoke searchable `LanguageSelector` consume it, so they stay identical.
  Change the styling there, never at the call site.
- If a primitive is genuinely missing, add it to `src/components/ui/` and use it
  everywhere. Do not style a one-off in a page component.
- If a primitive is close but not quite right, extend the primitive rather than
  overriding it with a pile of classNames at the call site.

## Agent workflow for UI changes

Before editing:

1. Identify the user job and the state the screen must communicate.
2. Check whether the current copy is specific or generic.
3. Check if there is one obvious next action.

While editing:

1. Improve copy and hierarchy before adding motion.
2. Prefer one small focused change over a broad redesign.
3. Keep privacy/local-first tone.
4. Use existing shadcn/ui and Tailwind patterns.

After editing:

1. Run `npm run build:renderer` for UI changes.
2. Run `npm run format:check` if markdown or formatting-sensitive files changed.
3. Include before/after notes in the final report.

## Quick UI critique checklist

Use this before shipping a UI change:

- [ ] Main action is clear within 3 seconds.
- [ ] Copy names the real product behavior, not generic AI value.
- [ ] Status is visible and understandable.
- [ ] Error/unsupported/dev states explain what to do next.
- [ ] Spacing and grouping make the screen easier to scan.
- [ ] There is no decorative motion unless it clarifies state.
- [ ] The screen still feels calm, private, and practical.
