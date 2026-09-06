import { expect, test } from "./fixtures/electron-app";

test.use({ useThrowawayHome: true });

test("Read Aloud filters code before sentence splitting without loading a voice", async ({
  overlayWindow,
}) => {
  const result = await overlayWindow.evaluate(async () => {
    const api = (window as any).electronAPI;
    return {
      prose: await api.readAloudSplit(
        "Before the code.\n```js\nconst value = 123;\n```\nAfter the code."
      ),
      code: await api.readAloudSplit("```js\nconst value = 123;\n```"),
      engine: await api.readAloudEngineStatus(),
    };
  });
  expect(result.prose).toEqual(["Before the code.", "After the code."]);
  expect(result.code).toEqual([]);
  expect(result.engine.loaded).toBe(false);
});
