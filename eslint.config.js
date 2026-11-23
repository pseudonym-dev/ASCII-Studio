import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["web/src/**/*.js"],
    languageOptions: { globals: { ...globals.browser, __WORKER_SOURCE__: "readonly", __DEMO_URL__: "readonly", __EXAMPLES__: "readonly" } },
  },
  { files: ["test/**/*.{js,mjs}", "tools/**/*.mjs"], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }], eqeqeq: "error", "prefer-const": "error", "no-var": "error" } },
];
