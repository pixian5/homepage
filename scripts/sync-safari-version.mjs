#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function safariBuildNumber(version) {
  const parts = String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (!parts.length || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`invalid Safari version: ${version}`);
  }
  return parts.reduce((value, part) => value * 100 + part, 0);
}

export function syncSafariVersionText(text, version) {
  const marketingMatches = text.match(/MARKETING_VERSION = [^;]+;/g) || [];
  const buildMatches = text.match(/CURRENT_PROJECT_VERSION = [^;]+;/g) || [];
  if (!marketingMatches.length || !buildMatches.length) {
    throw new Error("Safari project has no version build settings");
  }
  const build = safariBuildNumber(version);
  return text
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);
}

export async function syncSafariProjectVersion(projectFile, packageFile) {
  const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
  if (!packageJson.version) throw new Error("package version is missing");
  const original = await readFile(projectFile, "utf8");
  const updated = syncSafariVersionText(original, packageJson.version);
  await writeFile(projectFile, updated, "utf8");
  return { version: packageJson.version, build: safariBuildNumber(packageJson.version) };
}

const modulePath = fileURLToPath(import.meta.url);
const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (scriptPath && modulePath === scriptPath) {
  const projectFile = path.resolve(process.argv[2] || "");
  const packageFile = path.resolve(process.argv[3] || "package.json");
  if (!process.argv[2]) throw new Error("usage: sync-safari-version.mjs <project.pbxproj> [package.json]");
  const result = await syncSafariProjectVersion(projectFile, packageFile);
  console.log(`[build] Safari version -> ${result.version} (${result.build})`);
}
