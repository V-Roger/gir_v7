import studio from "@sanity/eslint-config-studio";
import globals from "globals";

export default [
  { ignores: ["dist/", ".sanity/", "node_modules/"] },
  ...studio,
  // Maintenance scripts run in Node, not in the Studio's browser bundle.
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: globals.node } },
];
