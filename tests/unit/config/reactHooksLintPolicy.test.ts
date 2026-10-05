import { ESLint } from "eslint";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "../../..");
const eslint = new ESLint({
  cwd: resolve(root, "src"),
  overrideConfigFile: resolve(root, "src/eslint.config.js"),
});

async function messages(source: string) {
  const [result] = await eslint.lintText(source, {
    filePath: resolve(root, "src/lint-policy-fixture.tsx"),
  });
  return result.messages;
}

describe("React Hooks lint policy", () => {
  test("still rejects conditional Hooks", async () => {
    expect(
      await messages(`import { useState } from "react";
        export function Example({ enabled }) {
          if (enabled) { useState(0); }
          return null;
        }`)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "react-hooks/rules-of-hooks", severity: 2 }),
      ])
    );
  });

  test("still reports missing effect dependencies", async () => {
    expect(
      await messages(`import { useEffect } from "react";
        export function Example({ value }) {
          useEffect(() => { console.log(value); }, []);
          return null;
        }`)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "react-hooks/exhaustive-deps", severity: 1 }),
      ])
    );
  });

  test("reports new compiler diagnostics without hiding them", async () => {
    expect(await messages(`export function Example() { return <div>{Date.now()}</div>; }`)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "react-hooks/purity", severity: 1 }),
      ])
    );
  });
});
