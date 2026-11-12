# Session Log

Entries are appended at natural stopping points so the next session can pick up
the thread without re-reading git history.

## 2026-11-11 — issue #35: cf-ray cache-anomaly evidence + `/nan-debug`

**Done**

- Applied issue #35 through the owner's inline workflow for the repo's own
  surgery: intent resolution → ledger freeze (`docs/fix/issue-35-cf-ray-cache-evidence/`)
  → RED acceptance corpus → implementation → differential → gates.
- New `src/cache-anomaly.ts`: the provider observes `onResponse` (`cf-ray`) and
  raw `onProviderStreamEvent` chunks (`id`/`created`), compares each completed
  stream per model, and appends one JSONL record to
  `<agentDir>/nan-cache-anomalies.jsonl` when the #17 signature repeats. Bursts
  record the pair once; a write failure never breaks a stream.
- New `src/debug-report.ts` + `src/debug-command.ts`: `/nan-debug [topic]
  [--window N] [--out file] [--emit]` reads session JSONL plus the anomaly
  capture, writes a redacted report (`README.md`, `anonymized_usage.jsonl`,
  `turns.jsonl`, `anomalies.jsonl`, `metadata.json`), prints a preview and
  writes the zip only with `--emit`. `--window` is the only network path and
  stays behind the explicit flag.
- New `src/zip.ts`: store-method, sorted-entry, fixed-timestamp zip writer so
  identical inputs yield byte-identical archives on Bun and Node
  (`Bun.Archive` is Bun-only).
- `src/provider-factory.ts` composes the capture outermost; `src/index.ts`
  registers the command; README/README.es, CHANGELOG 1.5.4, version bump and
  AGENTS.md verified-facts updated.

**Checks**

- `bun test` → 374 pass / 0 fail; `bun run typecheck` → exit 0.
- Base-vs-change differential on real provider streams: identical output, no
  anomaly file. Zip validated with `unzip -t`.

**Next**

- External verifier verdict on the handoff; no open obligation rows.

## 2026-11-12 — issue #35: fold the external-verify advisories (correction batch)

**Done**

- Read the `EXTERNAL VERIFY` receipt (`docs/fix/issue-35-cf-ray-cache-evidence/external-verify.md`,
  2026-11-11: `VERIFIED`, 0 blockers, 5 advisories) and triaged under the
  owner's "triage and fix those that deserve to fix":
  - **A1 fixed** — `parseDebugArgs` now rejects a `--`-prefixed token as the
    `--out` value (usage message), so `--out --emit` can no longer succeed with
    `emit: false` nor `--out --window 2` parse as out=`--window`/topic=`2`.
  - **A2 fixed** — `--out ~/…` (and bare `~`) expands to the home directory
    (injectable `homedir`), so the README/README.es example writes
    `<home>/evidence` instead of a literal `~` dir in the session cwd.
  - **A3 fixed** — `AGENTS.md` command-time `ctx.modelRegistry` list gains
    `/nan-debug`.
  - **A4 fixed** — the duplicated `---` before the new section removed from
    README.md and README.es.md.
  - **A5 `wontfix`** — `MAJOR.MINOR ↔ pi release line` is the stronger
    invariant (npm latest 1.5.2, branch carries unpublished 1.5.4); recorded as
    `D-35-01` in the unit's `decisions.md`.
- Ledgers: `planning-obligations.md` gained O11–O13 (cut `planned`, flipped on
  foreground validators); `decisions.md` created with the
  `path-protection-records@1` justification + approval rows for the protected
  suite edit; SPEC `## Log`/`## Evidence` carry the batch.

**Checks**

- RED first: `bun test test/issue-35-nan-debug-command.test.ts` → 11 pass /
  2 fail (both reproducers), then → 13 pass / 0 fail / 52 expect() calls.
- `bun test` → 376 pass / 0 fail / 1664 expect() calls / 35 files;
  `bun run typecheck` → exit 0.
- Differential vs a `369bb56` copy in `mktemp` scratch: base 374/0/1653/35,
  typecheck 0 → additive-only (+2 tests, +11 expects, zero deletions).

**Disclosures**

- The red run's `--out ~/…` reproducer created a stray `~/` directory inside
  the repo cwd (the very bug under repair): removed, absent after the fix.
- Concurrent owner commit `d449261 chore(git): .gitignore` added `docs/` to
  `.gitignore` mid-batch; the new `decisions.md` / `external-verify.md` are
  git-ignored and remain untracked pending the owner's decision (not
  force-added over a fresh owner commit).
- Out-of-batch base defect reported, not folded: `README.es.md:439` has a
  second duplicated `---` (present at `origin/main:397`).

**Next**

- Owner decision: track or ignore `decisions.md` / `external-verify.md` under
  the new `docs/` ignore rule; then external verdict on the handoff.
