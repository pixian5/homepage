import { stripImports } from "../../scripts/bundle-firefox.mjs";

export function wrapFirefoxE2ERunner(source) {
  return `(function() {\n${stripImports(source)}\n})();\n`;
}
