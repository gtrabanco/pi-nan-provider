#!/usr/bin/env node
/**
 * Monitor PI SDK versions and NaN-related dependencies for pi-nan-provider.
 *
 * This script:
 * 1. Reads current versions from package.json (devDependencies and peerDependencies).
 * 2. Queries npm for latest versions.
 * 3. Flags version bumps and checks compatibility.
 *
 * Exit 0 = nothing to do.
 * Exit 1 = updates available.
 *
 * Usage:
 *   node scripts/check-pi-sdk-versions.mjs --report
 *   node scripts/check-pi-sdk-versions.mjs --fail
 *   node scripts/check-pi-sdk-versions.mjs  (JSON output for CI)
 */

import https from "node:https";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Packages that ship from the `@earendil-works` scope and carry Pi SDK code.
 * pi-nan-provider depends on these for AI model operations.
 */
const SDK_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
];

// ---------------------------------------------------------------------------
// Package.json reader
// ---------------------------------------------------------------------------

function readPackageJson() {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf-8");
  return JSON.parse(raw);
}

/**
 * Get the currently constrained version for a package from
 * devDependencies and peerDependencies.
 */
function getConstrainedVersion(pkg, packageName) {
  const sources = ["devDependencies", "peerDependencies"];
  for (const src of sources) {
    const ver = pkg[src]?.[packageName];
    if (ver) return { version: ver, source: src };
  }
  return null;
}

// ---------------------------------------------------------------------------
// npm registry client (no dependencies)
// ---------------------------------------------------------------------------

function npmGet(packageName) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      { headers: { accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`npm registry returned ${res.statusCode} for ${packageName}`));
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(JSON.parse(data)));
      }
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${packageName} from npm`));
    });
  });
}

function npmLatest(packageName) {
  return npmGet(packageName).then((data) => {
    const distTags = data["dist-tags"] ?? {};
    const latestVersion = distTags["latest"];
    if (!latestVersion) {
      throw new Error(`No "latest" dist-tag for ${packageName}`);
    }
    const versions = Object.keys(data.versions ?? {}).sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] ?? 0;
        const vb = pb[i] ?? 0;
        if (va < vb) return -1;
        if (va > vb) return 1;
      }
      return 0;
    });
    return { latestVersion, latestTag: "latest", allVersions: versions, data };
  });
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

function parseSemver(version) {
  // Handle versions like "1" (major only) or "1.2" (major.minor)
  let normalized = version;
  while (normalized.split(".").length < 3) {
    normalized += ".0";
  }
  const m = normalized.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: version };
}

function bumpLevel(current, target) {
  const c = parseSemver(current);
  const t = parseSemver(target);
  if (!c || !t) return "unknown";
  if (t.major > c.major) return "major";
  if (t.minor > c.minor) return "minor";
  if (t.patch > c.patch) return "patch";
  return "none";
}

/**
 * Check if a version satisfies a semver range.
 * Handles caret, tilde, comparison operators, and ranges.
 */
function checkSemverSatisfies(version, range) {
  const cVer = parseSemver(version);
  if (!cVer) return false;

  // Handle disjunction (OR): ">=1.0.0 <2.0.0 || >=3.0.0"
  if (range.includes("||")) {
    const parts = range.split("||").map((p) => p.trim());
    return parts.some((part) => checkSemverSatisfies(version, part));
  }

  // Handle conjunction (AND via spaces): ">=1.0.0 <2.0.0"
  const parts = [];
  let current = "";
  const tokens = range.split(/\s+/);
  for (const token of tokens) {
    if (token.startsWith(">=") || token.startsWith("<=") ||
        token.startsWith(">") || token.startsWith("<") || token.startsWith("=") ||
        token.startsWith("^") || token.startsWith("~")) {
      if (current && !current.startsWith("^") && !current.startsWith("~")) {
        parts.push(current);
      }
      current = token;
    } else if (current) {
      current = current + " " + token;
    } else {
      current = token;
    }
  }
  if (current) parts.push(current);

  if (parts.length > 1) {
    // Check each part
    return parts.every((part) => checkSemverSatisfies(version, part));
  }

  // Single constraint
  const constraint = range.trim();

  // Handle caret: ^X.Y.Z
  if (constraint.startsWith("^")) {
    const target = parseSemver(constraint.slice(1));
    if (!target) return false;
    // ^0.x: same major and minor >= target.minor
    // ^1.x+: same major and minor >= target.minor
    return cVer.major === target.major && cVer.minor >= target.minor;
  }

  // Handle tilde: ~X.Y.Z
  if (constraint.startsWith("~")) {
    const target = parseSemver(constraint.slice(1));
    if (!target) return false;
    return cVer.major === target.major && cVer.minor === target.minor && cVer.patch >= target.patch;
  }

  // Handle comparison: >=X.Y.Z, <X.Y.Z, =X.Y.Z, etc.
  let op = "";
  let verStr = constraint;
  if (constraint.startsWith(">=")) {
    op = ">=";
    verStr = constraint.slice(2);
  } else if (constraint.startsWith("<=")) {
    op = "<=";
    verStr = constraint.slice(2);
  } else if (constraint.startsWith(">")) {
    op = ">";
    verStr = constraint.slice(1);
  } else if (constraint.startsWith("<")) {
    op = "<";
    verStr = constraint.slice(1);
  } else if (constraint.startsWith("=")) {
    op = "=";
    verStr = constraint.slice(1);
  }

  const target = parseSemver(verStr);
  if (!target) return false;

  const cmp = semverCompare(cVer, target);

  switch (op) {
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case "<": return cmp < 0;
    case "=": return cmp === 0;
    default: return false;
  }
}

function semverCompare(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return (a.patch ?? 0) - (b.patch ?? 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    report: args.includes("--report"),
    fail: args.includes("--fail"),
  };

  const pkg = readPackageJson();

  const results = [];
  let exitCode = 0;

  for (const packageName of SDK_PACKAGES) {
    try {
      const npmInfo = await npmLatest(packageName);
      const constrained = getConstrainedVersion(pkg, packageName);

      if (!constrained) {
        results.push({
          packageName,
          status: "not-found",
          message: "Not found in package.json dependencies",
        });
        continue;
      }

      // Extract numeric version from constraint
      let constraintVer = constrained.version;
      // Remove version range operators to get the base version
      if (constraintVer.startsWith("^")) {
        constraintVer = constraintVer.slice(1);
      } else if (constraintVer.startsWith("~")) {
        constraintVer = constraintVer.slice(1);
      }

      const bump = bumpLevel(constraintVer, npmInfo.latestVersion);

      // Check if latest satisfies peer dependencies
      const peerRange = pkg.peerDependencies?.[packageName] ?? null;
      const latestSatisfiesPeer = peerRange
        ? checkSemverSatisfies(npmInfo.latestVersion, peerRange)
        : true;

      // Check if current satisfies peer dependencies
      const currentSatisfiesPeer = peerRange
        ? checkSemverSatisfies(constraintVer, peerRange)
        : true;

      const result = {
        packageName,
        source: constrained.source,
        constrainedVersion: constrained.version,
        constraintVer,
        latestVersion: npmInfo.latestVersion,
        latestTag: npmInfo.latestTag,
        bump,
        peerRange,
        latestSatisfiesPeer,
        currentSatisfiesPeer,
        totalVersions: npmInfo.allVersions.length,
        allVersions: npmInfo.allVersions,
      };

      // Determine status
      if (!currentSatisfiesPeer) {
        result.status = "WARNING";
        result.message = `Current version ${constraintVer} does NOT satisfy peer dependency range ${peerRange}`;
        exitCode = 1;
      } else if (bump === "major" && npmInfo.latestVersion !== constraintVer) {
        result.status = "BREAKING";
        result.message = `Major version bump: ${constraintVer} → ${npmInfo.latestVersion}. Review changelog before upgrading.`;
        if (latestSatisfiesPeer) {
          result.message += ` Latest version satisfies peer dependency range.`;
        } else {
          result.message += ` ⚠️ Latest version does NOT satisfy peer dependency range!`;
        }
        exitCode = 1;
      } else if (bump === "minor" && npmInfo.latestVersion !== constraintVer) {
        result.status = "minor";
        result.message = `Minor version bump: ${constraintVer} → ${npmInfo.latestVersion}. Check for API changes.`;
        exitCode = 1;
      } else if (bump === "patch" && npmInfo.latestVersion !== constraintVer) {
        result.status = "patch";
        result.message = `Patch version bump: ${constraintVer} → ${npmInfo.latestVersion}. May be safe to update.`;
      } else {
        result.status = "up-to-date";
        result.message = `Already on latest version.`;
      }

      if (latestSatisfiesPeer && bump !== "none") {
        result.message += ` Latest satisfies peer dependency range.`;
      } else if (!latestSatisfiesPeer) {
        result.message += ` Latest does NOT satisfy peer dependency range!`;
      }

      results.push(result);
    } catch (err) {
      results.push({
        packageName,
        status: "error",
        message: err.message,
      });
      exitCode = 1;
    }
  }

  // Print report
  if (flags.report) {
    console.log("\n=== PI SDK Version Monitor (pi-nan-provider) ===\n");

    for (const r of results) {
      if (r.status === "not-found") {
        console.log(`  ❌ ${r.packageName}: ${r.message}`);
        continue;
      }
      if (r.status === "error") {
        console.log(`  ⚠️  ${r.packageName}: ${r.message}`);
        continue;
      }
      if (r.status === "up-to-date") {
        console.log(`  ✅ ${r.packageName}: ${r.message} (${r.latestVersion})`);
        continue;
      }
      if (r.status === "WARNING") {
        console.log(`  ❗ ${r.packageName}: ${r.message} (current: ${r.constrainedVersion})`);
        continue;
      }
      const icon = r.status === "BREAKING" ? "🔴" : r.status === "minor" ? "🟡" : "🟢";
      console.log(`  ${icon} ${r.packageName}: ${r.message} (${r.source}: ${r.constrainedVersion})`);
      console.log(`     → Latest available: ${r.latestVersion} (tag: ${r.latestTag})`);
      if (r.peerRange) {
        console.log(`     → Peer dependency range: ${r.peerRange}`);
        console.log(`     → Latest satisfies peer range: ${r.latestSatisfiesPeer ? "✅" : "❌"}`);
      }
      if (r.bump === "major") {
        console.log(`     → Total versions published: ${r.totalVersions}`);
      }
    }

    console.log();
  } else {
    // JSON output for CI consumption
    console.log(JSON.stringify(results, null, 2));
  }

  if (flags.fail && exitCode === 1) {
    process.exit(1);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(2);
});
