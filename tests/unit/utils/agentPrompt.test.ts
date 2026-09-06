import { describe, expect, it } from "vitest";

import {
  AGENT_PROMPT_RULES,
  applySpokenKeys,
  cleanAgentPrompt,
  extractSendCommand,
  formatCodeReferences,
  tidyPunctuation,
} from "../../../src/utils/agentPrompt";

describe("cleanAgentPrompt (fallback): real rambles", () => {
  it("ramble 1: the login form crash", () => {
    const result = cleanAgentPrompt(
      "So um the login form, when I submit empty it uh crashes, I think it's in auth slash " +
        "login dot ts, the validate function, fix it and add a test, send."
    );

    expect(result.text).toBe(
      "So um the login form, when I submit empty it uh crashes, I think it's in " +
        "`auth/login.ts`, the `validate` function, fix it and add a test."
    );
    expect(result.send).toBe(true);
    expect(result.changed).toBe(true);
  });

  it("ramble 2: the hook re-rendering, with two spoken line breaks", () => {
    const result = cleanAgentPrompt(
      "Okay so, the the use effect in, um, in dashboard page dot tsx re-renders on every " +
        "keystroke, new line, I think the dependency array is missing user underscore id, " +
        "new line, fix it, don't touch the other hooks, send it."
    );

    // Three honest limits are pinned here: the hesitation survives now that the filler rules
    // are gone, "use effect" stays two words because no rule can know it is useEffect, and
    // "dot" only joins the token beside it, so the file name comes out as dashboard
    // `page.tsx` rather than `dashboard-page.tsx`.
    expect(result.text).toBe(
      "Okay so, the the use effect in, um, in dashboard `page.tsx` re-renders on every " +
        "keystroke.\n" +
        "I think the dependency array is missing `user_id`.\n" +
        "Fix it, don't touch the other hooks."
    );
    expect(result.send).toBe(true);
  });

  it("ramble 3: a mid-sentence send is content", () => {
    const result = cleanAgentPrompt(
      "Uh, can you send the error output to a file called debug log dot txt, no wait, " +
        "debug dot log, and then read it back."
    );

    expect(result.text).toBe(
      "Uh, can you send the error output to a file called debug `log.txt`, no wait, " +
        "`debug.log`, and then read it back."
    );
    expect(result.send).toBe(false);
  });

  it("ramble 4: an npm script failing", () => {
    const result = cleanAgentPrompt(
      "Um, the npm run build script fails on Windows, I think it's in package dot json, " +
        "the build command, can you check it, send."
    );

    expect(result.text).toBe(
      "Um, the npm run build script fails on Windows, I think it's in `package.json`, " +
        "the `build` command, can you check it."
    );
    expect(result.send).toBe(true);
  });

  it("ramble 5: a flaky Playwright test", () => {
    const result = cleanAgentPrompt(
      "So, uh, the playwright test for the login flow is flaky, it fails maybe one in five " +
        "runs, new line, look at tests slash e2e slash login dot spec dot ts and add a wait, " +
        "send it."
    );

    expect(result.text).toBe(
      "So, uh, the playwright test for the login flow is flaky, it fails maybe one in five " +
        "runs.\n" +
        "Look at `tests/e2e/login.spec.ts` and add a wait."
    );
    expect(result.send).toBe(true);
  });

  it("ramble 6: a git rebase, with no send", () => {
    const result = cleanAgentPrompt(
      "Okay, I need to rebase the feature slash auth dash 2 branch onto main, there are " +
        "conflicts in login dot ts, um, resolve them and keep my changes."
    );

    expect(result.text).toBe(
      "Okay, I need to rebase the `feature/auth-2` branch onto main, there are conflicts in " +
        "`login.ts`, um, resolve them and keep my changes."
    );
    expect(result.send).toBe(false);
  });

  it("ramble 7: a SQL migration", () => {
    const result = cleanAgentPrompt(
      "Um, the migration adds a user underscore id column to the orders table, but the " +
        "created underscore at field is um not null, so fix the migration and add a down " +
        "migration."
    );

    expect(result.text).toBe(
      "Um, the migration adds a `user_id` column to the `orders` table, but the `created_at` " +
        "field is um not null, so fix the migration and add a down migration."
    );
    expect(result.send).toBe(false);
  });

  it("ramble 8: renaming a flag across files, with send as content and as a command", () => {
    const result = cleanAgentPrompt(
      "So, rename the flag from send underscore enter to auto underscore send in settings " +
        "dot ts and in main dot js, new line, keep the old key working for one release, send it."
    );

    expect(result.text).toBe(
      "So, rename the flag from `send_enter` to `auto_send` in `settings.ts` and in " +
        "`main.js`.\n" +
        "Keep the old key working for one release."
    );
    expect(result.send).toBe(true);
  });

  it("ramble 9: a CSS layout bug, with a repeated false start", () => {
    const result = cleanAgentPrompt(
      "Um, the sidebar overlaps the, um, the main content on narrow windows, I think the " +
        "layout container class in app dot css is wrong, can you fix it and uh check the " +
        "mobile breakpoint."
    );

    expect(result.text).toBe(
      "Um, the sidebar overlaps the, um, the main content on narrow windows, I think the " +
        "layout `container` class in `app.css` is wrong, can you fix it and uh check the " +
        "mobile breakpoint."
    );
    expect(result.send).toBe(false);
  });

  it("ramble 10: a Rust panic, with a spoken :: path", () => {
    const result = cleanAgentPrompt(
      "Alright, the rust build fails with an error in crate colon colon parser, the parse " +
        "underscore line function panics on empty input, can you add a guard and send now."
    );

    expect(result.text).toBe(
      "Alright, the rust build fails with an error in `crate::parser`, the `parse_line` " +
        "function panics on empty input, can you add a guard."
    );
    expect(result.send).toBe(true);
  });
});

describe("cleanAgentPrompt: counterexamples", () => {
  it("leaves a mid-sentence send alone", () => {
    expect(cleanAgentPrompt("Send the email to the team first.")).toEqual({
      text: "Send the email to the team first.",
      send: false,
      changed: false,
    });
  });

  it("leaves a content 'no' alone", () => {
    expect(cleanAgentPrompt("The answer is no, keep the flag.")).toEqual({
      text: "The answer is no, keep the flag.",
      send: false,
      changed: false,
    });
  });

  it("leaves a sentence-initial 'Actually' alone", () => {
    expect(cleanAgentPrompt("Actually, let's use the other approach.")).toEqual({
      text: "Actually, let's use the other approach.",
      send: false,
      changed: false,
    });
  });

  it("leaves a URL bare and uncapitalised", () => {
    expect(cleanAgentPrompt("See https://example.com/docs/api.html for the spec.")).toEqual({
      text: "See https://example.com/docs/api.html for the spec.",
      send: false,
      changed: false,
    });
  });

  it("leaves an email address alone", () => {
    expect(cleanAgentPrompt("Email support@example.com about it.")).toEqual({
      text: "Email support@example.com about it.",
      send: false,
      changed: false,
    });
  });

  it("does not double-wrap an already backticked token", () => {
    expect(cleanAgentPrompt("Keep `useEffect` as it is.")).toEqual({
      text: "Keep `useEffect` as it is.",
      send: false,
      changed: false,
    });
  });

  it("wraps spoken camelCase but never joins separate spoken words", () => {
    expect(cleanAgentPrompt("Rename userId to accountId everywhere.").text).toBe(
      "Rename `userId` to `accountId` everywhere."
    );
    expect(cleanAgentPrompt("Rename user id to account id everywhere.").text).toBe(
      "Rename user id to account id everywhere."
    );
  });

  it("leaves ordinary hyphenated English bare", () => {
    expect(cleanAgentPrompt("The push-to-talk hotkey causes a re-render.").changed).toBe(false);
  });
});

describe("cleanAgentPrompt: contract", () => {
  const empty = { text: "", send: false, changed: false };

  it("treats undefined as an empty transcript", () => {
    expect(cleanAgentPrompt(undefined)).toEqual(empty);
  });

  it("treats null as an empty transcript", () => {
    expect(cleanAgentPrompt(null)).toEqual(empty);
  });

  it("treats a non-string as an empty transcript", () => {
    expect(cleanAgentPrompt(42 as unknown as string)).toEqual(empty);
  });

  it("treats a whitespace-only transcript as empty", () => {
    expect(cleanAgentPrompt("   \n  ")).toEqual(empty);
  });

  it("reports changed false when the rules had nothing to do", () => {
    expect(cleanAgentPrompt("Fix the failing test.")).toEqual({
      text: "Fix the failing test.",
      send: false,
      changed: false,
    });
  });

  it("reports changed true when only the trailing send was removed", () => {
    expect(cleanAgentPrompt("Fix the failing test, send.")).toEqual({
      text: "Fix the failing test.",
      send: true,
      changed: true,
    });
  });

  it("lists the four rules in order for a settings screen", () => {
    expect(AGENT_PROMPT_RULES.map((rule) => rule.id)).toEqual([
      "formatCodeReferences",
      "applySpokenKeys",
      "extractSendCommand",
      "tidyPunctuation",
    ]);
    expect(AGENT_PROMPT_RULES.map((rule) => rule.order)).toEqual([1, 2, 3, 4]);
  });

  it("cleans a 4,000 character transcript well under 50 ms", () => {
    let transcript = "";
    while (transcript.length < 4000) transcript += "um, uh, the the login form is broken, ";

    const started = performance.now();
    const result = cleanAgentPrompt(transcript);
    const elapsed = performance.now() - started;

    expect(result.text.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });
});

describe("formatCodeReferences", () => {
  it("joins spoken path separators and wraps the result", () => {
    expect(formatCodeReferences("auth slash login dot ts")).toBe("`auth/login.ts`");
    expect(formatCodeReferences("user underscore id")).toBe("`user_id`");
    expect(formatCodeReferences("crate colon colon parser")).toBe("`crate::parser`");
  });

  it("wraps a literal path Whisper already produced", () => {
    expect(formatCodeReferences("it is in auth/login.ts")).toBe("it is in `auth/login.ts`");
  });

  it("keeps a spoken 'dot' that is content", () => {
    expect(formatCodeReferences("the dot on the map")).toBe("the dot on the map");
    expect(formatCodeReferences("add a dot.")).toBe("add a dot.");
  });

  it("wraps the named thing in 'the X function' but not an adjective", () => {
    expect(formatCodeReferences("the validate function")).toBe("the `validate` function");
    expect(formatCodeReferences("the broken function")).toBe("the broken function");
  });

  it("wraps flags and scoped packages", () => {
    expect(formatCodeReferences("pass --send-enter and @types/node")).toBe(
      "pass `--send-enter` and `@types/node`"
    );
  });

  it("keeps sentence-final punctuation outside the backticks", () => {
    expect(formatCodeReferences("it is in login.ts.")).toBe("it is in `login.ts`.");
  });

  it("leaves ordinary hyphenated English and existing backticks alone", () => {
    expect(formatCodeReferences("push-to-talk and re-render")).toBe("push-to-talk and re-render");
    expect(formatCodeReferences("Keep `useEffect` as it is")).toBe("Keep `useEffect` as it is");
  });
});

describe("applySpokenKeys", () => {
  it("turns a spoken new line into a break and capitalises what follows", () => {
    expect(applySpokenKeys("fix it, new line, then test")).toBe("fix it\nThen test");
  });

  it("turns a spoken new paragraph into a blank line", () => {
    expect(applySpokenKeys("fix it, new paragraph, then test")).toBe("fix it\n\nThen test");
  });

  it("does not invent a break when 'newline' is content", () => {
    expect(applySpokenKeys("add a newline character")).toBe("add a newline character");
  });
});

describe("extractSendCommand", () => {
  it("strips a trailing send and the comma before it", () => {
    expect(extractSendCommand("fix it and add a test, send.")).toEqual({
      text: "fix it and add a test",
      send: true,
    });
  });

  it("accepts the rest of the send family", () => {
    expect(extractSendCommand("fix the build, send it").send).toBe(true);
    expect(extractSendCommand("fix the build and send").text).toBe("fix the build");
    expect(extractSendCommand("add a guard and send now.").text).toBe("add a guard");
  });

  it("counts a send right after a line break", () => {
    expect(extractSendCommand("fix the build\nsend")).toEqual({
      text: "fix the build",
      send: true,
    });
  });

  it("leaves a send that is not the tail", () => {
    expect(extractSendCommand("Send the email to the team first.")).toEqual({
      text: "Send the email to the team first.",
      send: false,
    });
  });

  it("does not treat 'go' or 'submit' as a send", () => {
    expect(extractSendCommand("fix the build, go").send).toBe(false);
    expect(extractSendCommand("fix the build, submit").send).toBe(false);
  });
});

describe("tidyPunctuation", () => {
  it("collapses doubled and leading punctuation", () => {
    expect(tidyPunctuation("the form, , crashes")).toBe("The form, crashes.");
    expect(tidyPunctuation(", fix the build")).toBe("Fix the build.");
  });

  it("removes a space before punctuation", () => {
    expect(tidyPunctuation("the form , crashes")).toBe("The form, crashes.");
  });

  it("never re-cases a backticked token or the word after it", () => {
    expect(tidyPunctuation("`useEffect` re-renders")).toBe("`useEffect` re-renders.");
  });

  it("keeps a question mark and existing contractions", () => {
    expect(tidyPunctuation("can you fix it?")).toBe("Can you fix it?");
    expect(tidyPunctuation("it's broken, it is not fixed")).toBe("It's broken, it is not fixed.");
  });
});
