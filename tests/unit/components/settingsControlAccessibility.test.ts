import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsRow } from "../../../src/components/ui/SettingsSection";
import { Toggle } from "../../../src/components/ui/toggle";

const toggle = (props: Partial<React.ComponentProps<typeof Toggle>> = {}) =>
  React.createElement(Toggle, { checked: true, onChange: () => {}, ...props });

function row(
  control: React.ReactNode = toggle(),
  description: React.ReactNode = "Keep a copy after dictation."
) {
  return React.createElement(SettingsRow, {
    label: "Copy to clipboard",
    description,
    children: control,
  });
}

function attribute(markup: string, name: string) {
  return markup.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

describe("settings control accessible text", () => {
  it("references the existing visible label and description through nested children", () => {
    const markup = renderToStaticMarkup(row(React.createElement("div", {}, toggle())));
    const labelId = attribute(markup, "aria-labelledby");
    const descriptionId = attribute(markup, "aria-describedby");
    expect(labelId).toBeDefined();
    expect(descriptionId).toBeDefined();
    expect(markup).toContain(`id="${labelId}"`);
    expect(markup).toContain("Copy to clipboard</p>");
    expect(markup).toContain(`id="${descriptionId}"`);
    expect(markup).toContain("Keep a copy after dictation.</p>");
    expect(markup).toContain('aria-pressed="true"');
  });

  it("omits the description reference when there is no description", () => {
    const markup = renderToStaticMarkup(row(toggle(), null));
    expect(attribute(markup, "aria-labelledby")).toBeDefined();
    expect(attribute(markup, "aria-describedby")).toBeUndefined();
  });

  it("keeps an explicit name instead of overriding it with the row label", () => {
    const markup = renderToStaticMarkup(row(toggle({ "aria-label": "Specific action" })));
    expect(attribute(markup, "aria-label")).toBe("Specific action");
    expect(attribute(markup, "aria-labelledby")).toBeUndefined();
    expect(attribute(markup, "aria-describedby")).toBeDefined();
  });

  it("honours explicit label and description references", () => {
    const markup = renderToStaticMarkup(
      row(
        toggle({
          "aria-labelledby": "custom-label",
          "aria-describedby": "custom-help",
        })
      )
    );
    expect(attribute(markup, "aria-labelledby")).toBe("custom-label");
    expect(attribute(markup, "aria-describedby")).toBe("custom-help");
  });

  it("uses separate IDs for rows and supports rich descriptions", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        {},
        row(toggle(), React.createElement("span", {}, "First description")),
        row()
      )
    );
    const labels = [...markup.matchAll(/aria-labelledby="([^"]*)"/g)].map((match) => match[1]);
    const descriptions = [...markup.matchAll(/aria-describedby="([^"]*)"/g)].map(
      (match) => match[1]
    );
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    expect(new Set(descriptions).size).toBe(2);
    expect(markup).toContain("<span>First description</span>");
  });

  it("preserves standalone names, disabled state and pressed state", () => {
    const markup = renderToStaticMarkup(
      toggle({ checked: false, disabled: true, "aria-label": "Debug mode" })
    );
    expect(attribute(markup, "aria-label")).toBe("Debug mode");
    expect(attribute(markup, "aria-labelledby")).toBeUndefined();
    expect(attribute(markup, "aria-describedby")).toBeUndefined();
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('disabled=""');
  });
});
