#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
const helperPath = path.join(path.dirname(modulePath), "clean-safari-homepage-registrations.py");

export const bundleId = "com.aeroluna.homepage.safari.extension";
export const currentRegistrationKey = `${bundleId} (WY97WQFBKC)`;
export const knownStaleRegistrationKeys = [`${bundleId} (PSTNW3UN4R)`, `${bundleId} (UNSIGNED)`];

export function staleKeys(keys) {
  const stale = new Set(knownStaleRegistrationKeys);
  return keys.filter((key) => stale.has(key));
}

export async function cleanFiles(files = []) {
  const { stdout } = await execFileAsync("python3", [helperPath, ...files], {
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

async function main() {
  const results = await cleanFiles(process.argv.slice(2));
  const removed = results.flatMap((result) => result.removed);
  if (removed.length) {
    console.log(`[safari] removed stale registrations: ${removed.join(", ")}`);
    for (const result of results.filter((entry) => entry.backup)) {
      console.log(`[safari] backup: ${result.backup}`);
    }
  } else {
    console.log("[safari] no stale homepage registrations found");
  }
}

if (path.resolve(process.argv[1] || "") === modulePath) {
  main().catch((error) => {
    console.error(error.stderr || error);
    process.exit(1);
  });
}
