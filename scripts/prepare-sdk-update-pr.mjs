#!/usr/bin/env node
/**
 * Prepare an SDK update PR for the packages monitored by
 * scripts/check-pi-sdk-versions.mjs: bump their devDependencies in
 * package.json and emit the branch/PR metadata the
 * `.github/workflows/check-pi-sdk-versions.yml` workflow needs to open the PR.
 *
 * This script ONLY edits package.json. Installing, testing, typechecking, the
 * type-surface diff, git and `gh pr create` stay in the workflow so a failure
 * anywhere aborts the PR.
 *
 * Usage:
 *   node scripts/prepare-sdk-update-pr.mjs --body-file /tmp/pr-body.md
 *
 * Output (stdout, single JSON line):
 *   {"updates":false}
 *   {"updates":true,"branch":"chore/pi-sdk-1.3.0","title":"...","bodyFile":"...",
 *    "bumps":[{"name":"@earendil-works/pi-ai","from":"1.2.0","to":"1.3.0"}]}
 *
 * Exit codes: 0 = nothing to do or prepared; 2 = unexpected failure.
 */

import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SDK_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"];

function npmLatest(packageName) {
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
				res.on("end", () => {
					const latest = JSON.parse(data)["dist-tags"]?.["latest"];
					if (!latest) reject(new Error(`No "latest" dist-tag for ${packageName}`));
					else resolve(latest);
				});
			},
		);
		req.on("error", reject);
		req.setTimeout(15_000, () => {
			req.destroy();
			reject(new Error(`Timeout fetching ${packageName} from npm`));
		});
	});
}

async function main() {
	const bodyFileArg = process.argv.indexOf("--body-file");
	const bodyFile =
		bodyFileArg !== -1 ? process.argv[bodyFileArg + 1] : "/tmp/sdk-update-pr-body.md";

	const packageUrl = new URL("../package.json", import.meta.url);
	const raw = readFileSync(packageUrl, "utf-8");
	const pkg = JSON.parse(raw);

	const bumps = [];
	for (const name of SDK_PACKAGES) {
		const from = pkg.devDependencies?.[name];
		if (!from) throw new Error(`${name} is not a devDependency of this package`);
		const to = await npmLatest(name);
		if (to !== from) bumps.push({ name, from, to });
	}

	if (bumps.length === 0) {
		console.log(JSON.stringify({ updates: false }));
		return;
	}

	// Bump via exact-string replacement so the rest of package.json (ordering,
	// indentation, other fields) is untouched.
	let updated = raw;
	for (const bump of bumps) {
		const needle = `"${bump.name}": "${bump.from}"`;
		if (!updated.includes(needle)) {
			throw new Error(`Could not locate ${needle} in package.json to bump it`);
		}
		updated = updated.replace(needle, `"${bump.name}": "${bump.to}"`);
	}
	writeFileSync(packageUrl, updated);

	const versionTag = bumps.map((b) => b.to).join("-");
	const branch = `chore/pi-sdk-${versionTag}`;
	const title = `chore: bump PI SDK to ${bumps.map((b) => `${b.name.split("/")[1]} ${b.to}`).join(" / ")}`;
	const peer = pkg.peerDependencies ?? {};

	const body = `## PI SDK update (automated)

Prepared from the weekly \`check-pi-sdk-versions\` run. Resolves the \`sdk-monitor\` issue
for this cycle. **A human must review the upstream changelog before merging** — a minor
pi release can change provider-relevant behavior (see \`AGENTS.md\` "Verified API facts").

### Version bumps

| Package | From | To | Peer range |
| --- | --- | --- | --- |
${bumps.map((b) => `| \`${b.name}\` | ${b.from} | **${b.to}** | \`${peer[b.name] ?? "n/a"}\` |`).join("\n")}

### Review checklist

- [ ] Upstream release notes reviewed (https://pi.dev/changelog)
- [ ] \`bun test\` + \`bun run typecheck\` green (executed by CI before this PR was opened)
- [ ] Type-surface diff (below) contains no removals this package uses
- [ ] Version policy applied: package MAJOR.MINOR realigns with the pi release line
      (\`package.json\` version bump included in this PR when the pi MINOR moved)

The results of the two sections below were produced by CI while preparing this PR.

## Verification

<!-- VERIFICATION -->

## Type-surface diff (previous → new)

<details><summary>Click to expand</summary>

<!-- SURFACE_DIFF -->

</details>
`;

	writeFileSync(bodyFile, body);
	console.log(
		JSON.stringify({
			updates: true,
			branch,
			title,
			bodyFile,
			bumps,
		}),
	);
}

main().catch((err) => {
	console.error("Fatal:", err.message);
	process.exit(2);
});
