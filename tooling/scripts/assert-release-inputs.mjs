// Release input assertions for @hiyori/kaji staging.
// Zero-dependency Node script so the release workflow does not need a
// separate package to run it. Exits non-zero and explains why when any
// precondition for `npm stage publish` is not met.
//
// Usage:
//   node tooling/scripts/assert-release-inputs.mjs --channel <next|latest> \
//     --package-dir <dir>
//
// Environment: GITHUB_SHA (optional) is included in the printed summary.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function fail(message) {
  console.error(`::error::${message}`);
  console.error(`release assertion failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--channel") args.channel = argv[i + 1];
    else if (argv[i] === "--package-dir") args.packageDir = argv[i + 1];
    else fail(`unknown argument ${argv[i]}`);
  }
  return args;
}

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const { channel, packageDir } = parseArgs(process.argv.slice(2));
if (channel !== "next" && channel !== "latest") {
  fail(`channel must be "next" or "latest", got "${channel}"`);
}
if (!packageDir) fail("--package-dir is required");

const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

if (manifest.name !== "@hiyori/kaji") {
  fail(`package name must be @hiyori/kaji, got "${manifest.name}"`);
}
if (manifest.private === true) {
  fail('package is marked "private": true and can never be published');
}
if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
  fail(`package version "${manifest.version}" is not valid semver`);
}

const version = manifest.version;
const [, , , , prerelease] = SEMVER.exec(version);
if (channel === "latest" && prerelease) {
  fail(`channel "latest" forbids a prerelease version, got ${version}`);
}
if (channel === "next" && !prerelease) {
  fail(`channel "next" requires a prerelease version, got ${version}`);
}

const sourceSha = process.env.GITHUB_SHA ?? "local";

console.log(`package        ${manifest.name}`);
console.log(`version        ${version}`);
console.log(`channel        ${channel} (dist-tag)`);
console.log(`source sha     ${sourceSha}`);

// Existing-version check against the public registry. Any version that
// already exists — published or staged — must never be staged again.
// Unknown failures (network, auth, registry errors) fail conservatively.
let registryState;
try {
  execFileSync("npm", ["view", `${manifest.name}@${version}`, "version", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  registryState = "exists";
} catch (error) {
  const output = String(error.stderr ?? "");
  registryState = output.includes("E404") || output.includes("404") ? "absent" : "unknown";
  if (registryState === "unknown") {
    console.error(output);
    fail(`could not verify ${manifest.name}@${version} on the registry; refusing to stage`);
  }
}

if (registryState === "exists") {
  fail(`${manifest.name}@${version} already exists on the registry; never overwrite a published or staged version`);
}
console.log(`registry       ${manifest.name}@${version} is not published`);
console.log("release inputs accepted");
