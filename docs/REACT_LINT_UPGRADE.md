# React Hooks lint upgrade

Inspected 2026-10-05 for eslint-plugin-react-hooks 7.1.1.

The v5 recommended preset enabled the core Hooks rules. The v7 preset also
enables React Compiler diagnostics, producing 56 errors in the existing app.
Adopting the dependency does not also migrate those components to compiler-ready
patterns.

The renderer config keeps `rules-of-hooks` as an error and `exhaustive-deps` as a
warning. It reports the other recommended rules as warnings. No compiler
diagnostic is hidden. These warnings remain follow-up work, and should be
promoted to errors as the affected components are repaired and verified.

This uses the custom-rule configuration documented by the React project:

- [Plugin configuration](https://github.com/react/react/blob/main/packages/eslint-plugin-react-hooks/README.md#custom-configuration)
- [Compiler diagnostics and incremental adoption](https://react.dev/reference/eslint-plugin-react-hooks)

The regression tests lint actual invalid examples to verify that conditional
Hooks still fail and missing dependencies and render impurity are reported.
