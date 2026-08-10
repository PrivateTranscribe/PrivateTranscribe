const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src/dist/**",
      "*.min.js",
      "build/**",
      // Gitignored local scratch. Linting it broke `npm run format:check`:
      // tmp/ hit EPERM on Windows, website/ is browser code the CommonJS
      // main-process config below cannot parse.
      "tmp/**",
      "website/**",
      "src/**", // src has its own config
    ],
  },
  // Main process files (CommonJS)
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.commonjs,
        ...globals.jest,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Relaxed rules - catch syntax errors but don't be too strict
      "no-unused-vars": ["warn", { varsIgnorePattern: "^_", argsIgnorePattern: "^_|^event|^err|^error" }],
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-control-regex": "off",
      "no-useless-catch": "off",
      "no-async-promise-executor": "off",
      "prefer-const": "off",
      "no-var": "off",
    },
  },
];
