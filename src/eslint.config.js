import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Design-system guardrails. Every rule here exists because the same mistake was
// already made and shipped — see docs/DESIGN_TASTE_GUIDE.md for the reasoning.
const uiPrimitive = (element, replacement) => ({
  selector: `JSXOpeningElement[name.name='${element}']`,
  message: `Do not use a native <${element}>. Use ${replacement} so every instance shares one design.`,
});

// Tailwind's stock palette and raw hex bypass the theme in src/index.css, so a token
// change stops propagating. Semantic tokens: primary, destructive, warning, success,
// info, pro, muted, foreground, surface-*, border-*.
const BANNED_COLOR_CLASS =
  String.raw`(^|\s)(bg|text|border|ring|from|to|via|fill|stroke|divide|outline|accent|caret|placeholder|shadow|decoration)-` +
  String.raw`(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}`;

const designSystemRules = {
  "no-restricted-syntax": [
    "error",
    uiPrimitive("select", "the Select primitive from components/ui/select"),
    {
      selector: `JSXAttribute[name.name='className'] Literal[value=/${BANNED_COLOR_CLASS}/]`,
      message:
        "Do not use Tailwind's stock palette. Use a theme token (primary, destructive, warning, success, info, pro, muted) so the colour follows src/index.css.",
    },
    {
      selector: String.raw`JSXAttribute[name.name='className'] Literal[value=/\[#[0-9A-Fa-f]{3,8}\]/]`,
      message:
        "Do not hardcode a hex colour in className. Add a token to @theme in src/index.css and use it.",
    },
    {
      selector: String.raw`JSXAttribute[name.name='className'] Literal[value=/(^|\s)dark:/]`,
      message:
        "PrivateTranscribe is dark-only and no custom dark variant is declared, so dark: follows the OS theme and will not fire reliably. Style the dark palette directly.",
    },
    {
      // Inline style objects bypass className entirely — same problem, different syntax.
      selector: String.raw`JSXAttribute[name.name='style'] Literal[value=/#[0-9A-Fa-f]{3,8}\b/]`,
      message:
        'Do not hardcode a hex colour in an inline style. Reference a theme token, e.g. "var(--color-primary)".',
    },
  ],
};

export default [
  { ignores: ["dist", "helpers/**", "utils/**"] },
  // JS and JSX files (renderer - ES modules)
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^_|^event|^err|^error" },
      ],
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-useless-catch": "off",
      "no-async-promise-executor": "off",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      ...designSystemRules,
    },
  },
  // TypeScript files
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      ...designSystemRules,
    },
  },
];
