// gate.test.ts — full suite per design Test Plan (7 groups, one test per diagram path).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONCEPTS,
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  type ConceptClass,
  type ConceptStat,
  type GateState,
  activeTargets,
  readConfig,
  applyConceptSteering,
  badqData,
  badqSuppressed,
  buildGatePrompt,
  chooseProbe,
  classifyConcept,
  computeStatus,
  conceptStats,
  debtWeight,
  detectConcepts,
  difficultyFor,
  drillDown,
  governorAllows,
  guardsAllow,
  isInfraPath,
  isSourcePath,
  isoWeek,
  knowledgePage,
  localDay,
  nextStateOnFire,
  parseDiff,
  progressReport,
  quietHours,
  readGaps,
  readState,
  riskiestWindow,
  scoreDiff,
  statuslineSegment,
  writeStateAtomic,
} from "./gate.ts";

const GATE = join(import.meta.dir, "gate.ts");

const RISKY = `export function alpha(x: number) {
  if (x > 0) { return x; }
  return 0;
}
export function beta(y: number) {
  try { return alpha(y); } catch { return -1; }
}
export function gamma(z: number) {
  for (let i = 0; i < z; i++) { if (i % 2 === 0) continue; }
  return z;
}
`;

function td(): string {
  return mkdtempSync(join(tmpdir(), "gate-test-"));
}

function sh(cwd: string, cmd: string[]): string {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(): { repo: string; sha: string } {
  const repo = td();
  sh(repo, ["git", "init", "-q", "-b", "main"]);
  sh(repo, ["git", "config", "user.email", "test@example.com"]);
  sh(repo, ["git", "config", "user.name", "test"]);
  writeFileSync(join(repo, "a.ts"), "export const one = 1;\n");
  sh(repo, ["git", "add", "a.ts"]);
  sh(repo, ["git", "commit", "-qm", "init"]);
  return { repo, sha: sh(repo, ["git", "rev-parse", "HEAD"]) };
}

function seedState(dir: string, patch: Partial<GateState>): void {
  writeStateAtomic(dir, { ...DEFAULT_STATE, ...patch });
}

function runGate(input: unknown, stateDirPath: string, rawInput?: string): { stdout: string; status: number | null } {
  const r = spawnSync(process.execPath, [GATE], {
    input: rawInput ?? JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, GATE_STATE_DIR: stateDirPath, COMPREHENSION_GATE_OFF: "" },
  });
  return { stdout: r.stdout ?? "", status: r.status };
}

function runCli(args: string[], stateDirPath: string): string {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    env: { ...process.env, GATE_STATE_DIR: stateDirPath },
  });
  return (r.stdout ?? "").trim();
}

function baseInput(cwd: string, session = "s1"): Record<string, unknown> {
  return {
    session_id: session,
    stop_hook_active: false,
    permission_mode: "default",
    stop_reason: "end_turn",
    cwd,
    hook_event_name: "Stop",
  };
}

function expectBlock(out: string, file?: string): void {
  const parsed = JSON.parse(out);
  expect(parsed.decision).toBe("block");
  expect(parsed.reason).toContain("COMPREHENSION GATE");
  if (file) expect(parsed.reason).toContain(file);
}

// local-time ISO for a given local date offset from a fixed anchor
const ANCHOR = new Date(2026, 6, 19, 12, 0, 0); // 2026-07-19 local noon
function daysAgoIso(n: number, hour = 10): string {
  const d = new Date(ANCHOR);
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ---------- Group 1: turn-context guards ----------

describe("guards", () => {
  test("stop_hook_active=true → allow", () => {
    const { stdout } = runGate({ ...baseInput(td()), stop_hook_active: true }, td());
    expect(stdout).toBe("");
  });

  test("permission_mode=plan → allow", () => {
    const { stdout } = runGate({ ...baseInput(td()), permission_mode: "plan" }, td());
    expect(stdout).toBe("");
  });

  test("stop_reason=max_tokens → allow", () => {
    const { stdout } = runGate({ ...baseInput(td()), stop_reason: "max_tokens" }, td());
    expect(stdout).toBe("");
  });

  test("malformed stdin → allow", () => {
    const { stdout, status } = runGate(null, td(), "not json at all {{{");
    expect(stdout).toBe("");
    expect(status).toBe(0);
  });

  test("missing session_id → allow (unit)", () => {
    expect(guardsAllow({ stop_hook_active: false, stop_reason: "end_turn" })).toBe(true);
    expect(guardsAllow(baseInput("/tmp"))).toBe(false);
    expect(guardsAllow({ session_id: "s", stop_hook_active: false })).toBe(false); // stop_reason absent ⇒ eligible
  });
});

// ---------- Group 2: diff acquisition ----------

describe("diff", () => {
  test("working-tree change to tracked file fires (no commit)", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    appendFileSync(join(repo, "a.ts"), RISKY);
    const { stdout } = runGate(baseInput(repo), sd);
    expectBlock(stdout, "a.ts");
  });

  test("untracked new source file fires (no commit, no add)", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    writeFileSync(join(repo, "risky.ts"), RISKY);
    const { stdout } = runGate(baseInput(repo), sd);
    expectBlock(stdout, "risky.ts");
  });

  test("committed change fires", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    writeFileSync(join(repo, "risky.ts"), RISKY);
    sh(repo, ["git", "add", "risky.ts"]);
    sh(repo, ["git", "commit", "-qm", "risky"]);
    const { stdout } = runGate(baseInput(repo), sd);
    expectBlock(stdout, "risky.ts");
  });

  test("first run (no last_sha) scores last commit + tree", () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "risky.ts"), RISKY);
    sh(repo, ["git", "add", "risky.ts"]);
    sh(repo, ["git", "commit", "-qm", "risky"]);
    const { stdout } = runGate(baseInput(repo), td()); // empty state dir
    expectBlock(stdout, "risky.ts");
  });

  test("repo with no commits → allow", () => {
    const repo = td();
    sh(repo, ["git", "init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "risky.ts"), RISKY);
    const { stdout } = runGate(baseInput(repo), td());
    expect(stdout).toBe("");
  });

  test("non-git cwd → allow", () => {
    const dir = td();
    writeFileSync(join(dir, "risky.ts"), RISKY);
    const { stdout } = runGate(baseInput(dir), td());
    expect(stdout).toBe("");
  });

  test("git error (bogus last_sha) → allow", () => {
    const { repo } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
    appendFileSync(join(repo, "a.ts"), RISKY);
    const { stdout } = runGate(baseInput(repo), sd);
    expect(stdout).toBe("");
  });

  test("lockfile-only change → allow", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    writeFileSync(join(repo, "deps.lock"), RISKY); // risky-looking content, excluded path
    const { stdout } = runGate(baseInput(repo), sd);
    expect(stdout).toBe("");
  });

  test("rename-only change → allow", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    sh(repo, ["git", "mv", "a.ts", "b.ts"]);
    const { stdout } = runGate(baseInput(repo), sd);
    expect(stdout).toBe("");
  });

  test("isSourcePath excludes generated/vendored paths (unit)", () => {
    expect(isSourcePath("src/x.ts")).toBe(true);
    expect(isSourcePath("yarn.lock")).toBe(false);
    expect(isSourcePath("node_modules/x/y.js")).toBe(false);
    expect(isSourcePath("admin/node_modules.nosync/@babel/core/lib/config.js")).toBe(false); // iCloud suffix
    expect(isSourcePath(".git/hooks/pre-commit.sh")).toBe(false);
    expect(isSourcePath("dist/out.js")).toBe(false);
    expect(isSourcePath("types.d.ts")).toBe(false);
    expect(isSourcePath("app.min.js")).toBe(false);
    expect(isSourcePath("README.md")).toBe(false);
  });
});

// ---------- Group 3: digest anti-refire ----------

describe("digest", () => {
  test("identical dirty tree across sessions → second invocation allowed; changed tree fires again", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    writeFileSync(join(repo, "risky.ts"), RISKY);

    const first = runGate(baseInput(repo, "s1"), sd);
    expectBlock(first.stdout, "risky.ts");

    // neutralize governor (new session, old gate ts), keep digest
    const fired = JSON.parse(readFileSync(join(sd, "state.json"), "utf8")) as GateState;
    expect(fired.session_marker).toBe("s1");
    expect(fired.last_gated_digest).toBeTruthy();
    const staleTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeStateAtomic(sd, { ...fired, session_marker: "someone-else", last_gate_ts: staleTs });

    const second = runGate(baseInput(repo, "s2"), sd);
    expect(second.stdout).toBe(""); // same tree, same digest → no re-fire

    appendFileSync(join(repo, "risky.ts"), "export function delta(q: number) {\n  if (q) { return q; }\n  return 1;\n}\n");
    writeStateAtomic(sd, { ...fired, session_marker: "someone-else", last_gate_ts: staleTs });
    const third = runGate(baseInput(repo, "s3"), sd);
    expectBlock(third.stdout, "risky.ts"); // digest differs → fires
  });
});

// ---------- Group 4: risk scorer ----------

const DIFF_NEW_FILE = `diff --git a/x.ts b/x.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/x.ts
@@ -0,0 +1,4 @@
+export function hi(a: number) {
+  if (a > 0) { return 1; }
+  return 0;
+}
`;

const DIFF_TRIVIAL = `diff --git a/x.ts b/x.ts
index abc1234..def5678 100644
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
-const label = "old";
+const label = "new";
`;

describe("scorer", () => {
  test("trivial change scores below threshold", () => {
    const { total } = scoreDiff(parseDiff(DIFF_TRIVIAL), new Set(["x.ts"]));
    expect(total).toBeLessThan(5);
  });

  test("new file with function + control flow scores at/above threshold", () => {
    const { total, top } = scoreDiff(parseDiff(DIFF_NEW_FILE), new Set());
    // 3×1 fn + cf(if) + 2 new file + 2 never gated ≥ 5
    expect(total).toBeGreaterThanOrEqual(5);
    expect(top?.file).toBe("x.ts");
  });

  test("previously-gated file loses the never-gated bonus", () => {
    const fresh = scoreDiff(parseDiff(DIFF_NEW_FILE), new Set());
    const gated = scoreDiff(parseDiff(DIFF_NEW_FILE), new Set(["x.ts"]));
    expect(fresh.total - gated.total).toBe(2);
  });

  test("hunk selection caps at 50 lines and marks truncation", () => {
    const added = Array.from({ length: 80 }, (_, i) => `+const v${i} = ${i};`).join("\n");
    const bigDiff = `diff --git a/big.ts b/big.ts\nnew file mode 100644\n--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,80 @@\n${added}\n`;
    const { top } = scoreDiff(parseDiff(bigDiff), new Set());
    expect(top).toBeTruthy();
    const lines = (top as { text: string }).text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(52); // header + 50 + truncation marker
    expect((top as { text: string }).text).toContain("truncated");
  });
});

// ---------- Group 5: governor ----------

describe("governor", () => {
  const now = ANCHOR;

  test("same session marker with spent budget → allow", () => {
    expect(governorAllows({ ...DEFAULT_STATE, session_marker: "s1", session_count: 1 }, "s1", now)).toBe(true);
    expect(governorAllows({ ...DEFAULT_STATE, session_marker: "s1", session_count: 1 }, "s2", now)).toBe(false);
  });

  test("daily cap of 3 → allow; day rollover resets", () => {
    const capped: GateState = { ...DEFAULT_STATE, daily_count: 3, day: localDay(now) };
    expect(governorAllows(capped, "s2", now)).toBe(true);
    const yesterdayCapped: GateState = { ...DEFAULT_STATE, daily_count: 3, day: "2026-07-18" };
    expect(governorAllows(yesterdayCapped, "s2", now)).toBe(false); // eligible again
    const next = nextStateOnFire(yesterdayCapped, "s2", "sha", "digest", now);
    expect(next.daily_count).toBe(1); // rollover reset
    expect(next.day).toBe(localDay(now));
  });

  test("45-minute minimum gap", () => {
    const recent = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const stale = new Date(now.getTime() - 46 * 60 * 1000).toISOString();
    expect(governorAllows({ ...DEFAULT_STATE, last_gate_ts: recent }, "s2", now)).toBe(true);
    expect(governorAllows({ ...DEFAULT_STATE, last_gate_ts: stale }, "s2", now)).toBe(false);
  });

  test("snooze_until future → allow; past → eligible", () => {
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    expect(governorAllows({ ...DEFAULT_STATE, snooze_until: future }, "s2", now)).toBe(true);
    expect(governorAllows({ ...DEFAULT_STATE, snooze_until: past }, "s2", now)).toBe(false);
  });

  test("same session immediately after a fire → allow (end-to-end)", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    writeFileSync(join(repo, "risky.ts"), RISKY);
    expectBlock(runGate(baseInput(repo, "s1"), sd).stdout);
    expect(runGate(baseInput(repo, "s1"), sd).stdout).toBe("");
  });
});

// ---------- Group 6: state integrity ----------

describe("state", () => {
  test("missing state.json → defaults", () => {
    const { state, corrupt } = readState(td());
    expect(state).toEqual(DEFAULT_STATE);
    expect(corrupt).toBe(false);
  });

  test("corrupt state.json → defaults + allow + repaired on disk (end-to-end)", () => {
    const { repo } = initRepo();
    const sd = td();
    writeFileSync(join(sd, "state.json"), "{{{ not json");
    writeFileSync(join(repo, "risky.ts"), RISKY);
    const { stdout } = runGate(baseInput(repo), sd);
    expect(stdout).toBe(""); // never block on broken state
    const repaired = JSON.parse(readFileSync(join(sd, "state.json"), "utf8"));
    expect(repaired).toEqual(DEFAULT_STATE);
  });

  test("corrupt trailing gaps.jsonl line is skipped, good lines kept", () => {
    const sd = td();
    writeFileSync(
      join(sd, "gaps.jsonl"),
      `{"ts":"${daysAgoIso(0)}","sha":"abc","file":"x.ts","score":2,"missed":"","skipped":false}\n{broken json\n`,
    );
    const gaps = readGaps(sd);
    expect(gaps.length).toBe(1);
    expect(gaps[0].file).toBe("x.ts");
  });

  test("write is tmp+rename: no partial file after success, prior state survives failed write", () => {
    const sd = td();
    const v1: GateState = { ...DEFAULT_STATE, session_marker: "v1" };
    writeStateAtomic(sd, v1);
    expect(readdirSync(sd)).toEqual(["state.json"]); // no tmp left behind

    chmodSync(sd, 0o555);
    try {
      expect(() => writeStateAtomic(sd, { ...DEFAULT_STATE, session_marker: "v2" })).toThrow();
    } finally {
      chmodSync(sd, 0o755);
    }
    expect(readState(sd).state.session_marker).toBe("v1"); // intact, not partial
  });

  test(
    "state write precedes block: unwritable state dir → allow despite risky diff (end-to-end)",
    () => {
      const { repo, sha } = initRepo();
      const sd = td();
      seedState(sd, { last_sha: sha });
      writeFileSync(join(repo, "risky.ts"), RISKY);
      chmodSync(sd, 0o555);
      try {
        const { stdout } = runGate(baseInput(repo), sd);
        expect(stdout).toBe(""); // cannot record the gate → must not fire
      } finally {
        chmodSync(sd, 0o755);
      }
    },
    20000,
  );
});

// ---------- Group 7: streak helper ----------

describe("streak", () => {
  test("skips never count", () => {
    const gaps = [{ ts: daysAgoIso(0), sha: "a", file: "x.ts", score: null, missed: "", skipped: true }];
    expect(computeStatus(gaps, ANCHOR)).toEqual({ streak: 0, files: 0 });
  });

  test("score >= 1 required", () => {
    const gaps = [{ ts: daysAgoIso(0), sha: "a", file: "x.ts", score: 0, missed: "", skipped: false }];
    expect(computeStatus(gaps, ANCHOR).streak).toBe(0);
  });

  test("consecutive days end at a gap day", () => {
    const gaps = [
      { ts: daysAgoIso(0), sha: "a", file: "x.ts", score: 2, missed: "", skipped: false },
      { ts: daysAgoIso(1), sha: "b", file: "y.ts", score: 1, missed: "", skipped: false },
      { ts: daysAgoIso(2), sha: "c", file: "z.ts", score: null, missed: "", skipped: true }, // break
      { ts: daysAgoIso(3), sha: "d", file: "w.ts", score: 2, missed: "", skipped: false },
    ];
    const { streak, files } = computeStatus(gaps, ANCHOR);
    expect(streak).toBe(2);
    expect(files).toBe(3); // x, y, w (skip excluded)
  });

  test("--status CLI output (end-to-end)", () => {
    const sd = td();
    writeFileSync(
      join(sd, "gaps.jsonl"),
      `{"ts":"${new Date().toISOString()}","sha":"abc","file":"x.ts","score":2,"missed":"","skipped":false}\n`,
    );
    expect(runCli(["--status"], sd)).toBe("1-day streak · 1 files explained");
  });

  test("--snooze CLI sets snooze_until to future (end-to-end)", () => {
    const sd = td();
    seedState(sd, { session_marker: "keep-me" });
    expect(runCli(["--snooze"], sd)).toContain("Snoozed until");
    const { state } = readState(sd);
    expect(state.snooze_until).toBeTruthy();
    expect(Date.parse(state.snooze_until as string)).toBeGreaterThan(Date.now());
    expect(state.session_marker).toBe("keep-me"); // rest of state preserved
  });
});

// ---------- Group 8: concept model ----------

function gateLine(daysAgo: number, file: string, score: number | null, concepts: string[], skipped = false) {
  return { ts: daysAgoIso(daysAgo), sha: "abc", file, score, missed: "", skipped, concepts };
}

describe("concepts", () => {
  test("detectConcepts tags by content and extension", () => {
    expect(detectConcepts(["try { x(); } catch (e) { throw e; }"], "a.ts")).toContain("error-handling");
    expect(detectConcepts(["const r = await fetch(url);"], "a.ts")).toEqual(
      expect.arrayContaining(["async-concurrency", "network-http"]),
    );
    expect(detectConcepts(["const x = 1;"], "style.css")).toContain("ui-frontend");
    expect(detectConcepts(["const x = 1;"], "a.ts")).toEqual([]);
  });

  test("conceptStats aggregates scores and self entries; old lines without concepts ignored", () => {
    const gaps = [
      gateLine(3, "x.ts", 0, ["regex"]),
      gateLine(2, "y.ts", 1, ["regex", "error-handling"]),
      { ts: daysAgoIso(1), sha: "z", file: "z.ts", score: 2, missed: "", skipped: false }, // pre-concepts line
      { type: "self", ts: daysAgoIso(1), concept: "processes", comfort: 2 },
    ];
    const stats = conceptStats(gaps);
    expect(stats.get("regex")?.attempts).toBe(2);
    expect(stats.get("regex")?.avg).toBe(0.5);
    expect(stats.get("error-handling")?.attempts).toBe(1);
    expect(stats.get("processes")?.lastComfort).toBe(2);
  });

  test("classifyConcept: struggling / strength / growing / self-report override", () => {
    expect(classifyConcept({ attempts: 2, avg: 0.5, recentAvg: 0.5, prevAvg: null, lastComfort: null, lastSelfTs: null })).toBe("struggling");
    expect(classifyConcept({ attempts: 4, avg: 1.75, recentAvg: 2, prevAvg: 1, lastComfort: null, lastSelfTs: null })).toBe("strength");
    expect(classifyConcept({ attempts: 5, avg: 1.2, recentAvg: 1.7, prevAvg: 1.0, lastComfort: null, lastSelfTs: null })).toBe("growing");
    expect(classifyConcept({ attempts: 4, avg: 1.8, recentAvg: 2, prevAvg: 1.5, lastComfort: 2, lastSelfTs: daysAgoIso(1) })).toBe("struggling"); // self-report wins
  });

  test("chooseProbe: prefers hunk concept, respects 7-day cooldown, max one", () => {
    const struggling = (lastSelfTs: string | null) => ({
      attempts: 2, avg: 0.5, recentAvg: 0.5, prevAvg: null, lastComfort: null, lastSelfTs,
    });
    const stats = new Map([
      ["regex", struggling(null)],
      ["processes", struggling(null)],
    ]);
    expect(chooseProbe(stats, ANCHOR, ["processes"])?.id).toBe("processes"); // in-hunk preferred
    expect(chooseProbe(stats, ANCHOR, [])?.id).toBe("processes"); // tie → lexicographic
    const cooled = new Map([["regex", struggling(daysAgoIso(2))]]);
    expect(chooseProbe(cooled, ANCHOR, ["regex"])).toBeNull(); // probed 2 days ago
    const expired = new Map([["regex", struggling(daysAgoIso(8))]]);
    expect(chooseProbe(expired, ANCHOR, ["regex"])?.id).toBe("regex"); // cooldown over
  });

  test("scorer: struggling concept boosts +2, all-strength reduces", () => {
    const classes = (c: ConceptClass) => new Map<string, ConceptClass>([["error-handling", c]]);
    const hunkDiff = `diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n+try { risky(); } catch (e) { throw e; }\n`;
    const neutral = scoreDiff(parseDiff(hunkDiff), new Set(["x.ts"]));
    const boosted = scoreDiff(parseDiff(hunkDiff), new Set(["x.ts"]), classes("struggling"));
    const reduced = scoreDiff(parseDiff(hunkDiff), new Set(["x.ts"]), classes("strength"));
    expect(boosted.total - neutral.total).toBe(2);
    expect(neutral.total - reduced.total).toBe(2);
    expect(neutral.top?.concepts).toContain("error-handling");
  });

  test("gate prompt embeds concepts, quality rule, no-clue hatch; probe step only when given", () => {
    const args = {
      file: "x.ts", hunk: "@@ +1 @@\n+try {} catch {}", shortSha: "abcd1234",
      gapsPath: "/g/gaps.jsonl", scriptPath: "/g/gate.ts", bunPath: "/bin/bun",
      concepts: ["error-handling"], probe: null,
    };
    const without = buildGatePrompt(args);
    expect(without).toContain('"concepts":["error-handling"]');
    expect(without).toContain("QUESTION QUALITY RULE");
    expect(without).toContain('"no clue"');
    expect(without).toContain("--bad-q");
    expect(without).not.toContain("CALIBRATION");
    const withProbe = buildGatePrompt({ ...args, probe: { id: "regex", label: "regular expressions" } });
    expect(withProbe).toContain("CALIBRATION");
    expect(withProbe).toContain('"concept":"regex"');
  });
});

// ---------- Group 9: bad-question training ----------

describe("badq", () => {
  test("badqData: file map + concepts flagged twice", () => {
    const gaps = [
      { type: "badq", ts: daysAgoIso(1), file: "x.ts", concepts: ["regex"] },
      { type: "badq", ts: daysAgoIso(0), file: "y.ts", concepts: ["regex", "testing"] },
    ];
    const { files, concepts } = badqData(gaps);
    expect(files.get("x.ts")).toBeTruthy();
    expect(concepts.has("regex")).toBe(true); // flagged 2×
    expect(concepts.has("testing")).toBe(false); // only 1×
  });

  test("badqSuppressed: 14-day window", () => {
    const files = new Map([
      ["recent.ts", daysAgoIso(3)],
      ["old.ts", daysAgoIso(20)],
    ]);
    expect(badqSuppressed(files, "recent.ts", ANCHOR)).toBe(true);
    expect(badqSuppressed(files, "old.ts", ANCHOR)).toBe(false);
    expect(badqSuppressed(files, "never.ts", ANCHOR)).toBe(false);
  });

  test("badq'd concept loses boost (-2 vs neutral)", () => {
    const hunkDiff = `diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n+try { risky(); } catch (e) { throw e; }\n`;
    const neutral = scoreDiff(parseDiff(hunkDiff), new Set(["x.ts"]));
    const flagged = scoreDiff(parseDiff(hunkDiff), new Set(["x.ts"]), undefined, new Set(["error-handling"]));
    expect(neutral.total - flagged.total).toBe(2);
  });

  test("--bad-q CLI flags last gate entry (end-to-end)", () => {
    const sd = td();
    writeFileSync(
      join(sd, "gaps.jsonl"),
      JSON.stringify(gateLine(0, "x.ts", 2, ["regex"])) + "\n",
    );
    expect(runCli(["--bad-q", "config", "trivia"], sd)).toContain("x.ts");
    const gaps = readGaps(sd);
    expect(gaps.length).toBe(2);
    expect(gaps[1].type).toBe("badq");
    expect(gaps[1].file).toBe("x.ts");
    expect(gaps[1].concepts).toEqual(["regex"]);
  });

  test("--bad-q with empty log says so (end-to-end)", () => {
    expect(runCli(["--bad-q"], td())).toContain("No gate on record");
  });

  test("config-ish files excluded from targeting (unit)", () => {
    expect(isSourcePath("vite.config.ts")).toBe(false);
    expect(isSourcePath(".eslintrc.js")).toBe(false);
    expect(isSourcePath("src/.prettierrc.cjs")).toBe(false);
    expect(isSourcePath("config/database.ts")).toBe(false);
    expect(isSourcePath("src/commands.ts")).toBe(true);
  });
});

// ---------- Group 10: progress report ----------

describe("progress", () => {
  test("report groups strengths / growing / pushing-against / unseen", () => {
    const gaps = [
      gateLine(5, "a.ts", 2, ["error-handling"]),
      gateLine(4, "b.ts", 2, ["error-handling"]),
      gateLine(3, "c.ts", 2, ["error-handling"]),
      gateLine(2, "d.ts", 0, ["regex"]),
      gateLine(1, "e.ts", 0, ["regex"]),
      gateLine(0, "f.ts", null, ["testing"], true), // skip — excluded from stats
    ];
    const report = progressReport(gaps, ANCHOR);
    expect(report).toContain("6 gates (5 completed, 1 skipped)");
    expect(report).toContain("pass 60%");
    expect(report).toContain("Strengths: error handling (2.0 avg, 3×)");
    expect(report).toContain("Pushing against: regular expressions (0.0 avg, 2×)");
    expect(report).toContain("Not yet seen:");
    expect(report).not.toContain("testing (");
  });

  test("--progress CLI (end-to-end)", () => {
    const sd = td();
    writeFileSync(
      join(sd, "gaps.jsonl"),
      [gateLine(1, "a.ts", 0, ["regex"]), gateLine(0, "b.ts", 0, ["regex"])].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    const out = runCli(["--progress"], sd);
    expect(out).toContain("Pushing against: regular expressions");
  });

  test("empty log → n/a pass rate, no crash", () => {
    expect(progressReport([], ANCHOR)).toContain("pass n/a");
  });
});

// ---------- Group 11: infra vocabulary ----------

describe("infra vocab", () => {
  test("infra paths pass isSourcePath; generic yaml/config stays out", () => {
    expect(isSourcePath(".github/workflows/ci.yml")).toBe(true);
    expect(isSourcePath("app/.github/workflows/deploy.yaml")).toBe(true);
    expect(isSourcePath("Dockerfile")).toBe(true);
    expect(isSourcePath("services/api/Dockerfile.prod")).toBe(true);
    expect(isSourcePath("docker-compose.override.yml")).toBe(true);
    expect(isSourcePath("infra/main.tf")).toBe(true);
    expect(isSourcePath("Makefile")).toBe(true);
    expect(isSourcePath("values.yaml")).toBe(false); // generic yaml excluded
    expect(isSourcePath("k8s/deployment.yaml")).toBe(false);
    expect(isSourcePath("node_modules/pkg/Dockerfile")).toBe(false); // vendored infra excluded
    expect(isInfraPath(".github/workflows/ci.yml")).toBe(true);
  });

  test("infra concepts detected by path and content", () => {
    expect(detectConcepts(["jobs:", "  build:", "    runs-on: ubuntu-latest"], ".github/workflows/ci.yml")).toContain("devops-ci");
    expect(detectConcepts(["FROM node:20", "RUN npm ci"], "Dockerfile")).toContain("containers");
    expect(detectConcepts(['resource "aws_s3_bucket" "b" {'], "main.tf")).toContain("infra-as-code");
    expect(detectConcepts(["anything"], "Makefile")).toContain("build-tooling");
  });

  test("workflow edit fires the gate end-to-end with devops-ci tagged", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    // untracked workflow file — heavy CI content to clear the threshold
    const wfDir = join(repo, ".github", "workflows");
    spawnSync("mkdir", ["-p", wfDir]);
    writeFileSync(
      join(wfDir, "ci.yml"),
      "name: ci\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: if [ -f bun.lock ]; then bun test; fi\n      - run: for f in *.ts; do echo $f; done\n",
    );
    const { stdout } = runGate(baseInput(repo), sd);
    const parsed = JSON.parse(stdout);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("ci.yml");
    expect(parsed.reason).toContain('"concepts":["devops-ci"');
  });
});

// ---------- Group 12: growth targets ----------

describe("targets", () => {
  test("activeTargets replays on/off events, last wins", () => {
    const gaps = [
      { type: "target", ts: daysAgoIso(3), concept: "devops-ci", on: true },
      { type: "target", ts: daysAgoIso(2), concept: "regex", on: true },
      { type: "target", ts: daysAgoIso(1), concept: "devops-ci", on: false },
      { type: "target", ts: daysAgoIso(0), concept: "devops-ci", on: true },
    ];
    expect([...activeTargets(gaps)].sort()).toEqual(["devops-ci", "regex"]);
  });

  test("steering: target +3, struggling +2 (non-stacking), badq −2 overrides target", () => {
    const classes = new Map<string, ConceptClass>([["regex", "struggling"]]);
    const targets = new Set(["regex"]);
    expect(applyConceptSteering(5, ["regex"], classes, targets)).toBe(8); // target wins, no stack
    expect(applyConceptSteering(5, ["regex"], classes)).toBe(7); // struggling alone
    expect(applyConceptSteering(5, ["regex"], classes, targets, new Set(["regex"]))).toBe(3); // badq overrides
    expect(applyConceptSteering(5, [], classes, targets)).toBe(5); // no concepts, no steer
  });

  test("probe: targeted concept with zero attempts is eligible, targeted-in-hunk outranks struggling", () => {
    const struggling: ConceptStat = { attempts: 2, avg: 0.5, recentAvg: 0.5, prevAvg: null, lastComfort: null, lastSelfTs: null };
    const stats = new Map([["regex", struggling]]);
    const targets = new Set(["devops-ci"]);
    expect(chooseProbe(stats, ANCHOR, ["devops-ci", "regex"], targets)?.id).toBe("devops-ci");
    expect(chooseProbe(new Map(), ANCHOR, [], targets)?.id).toBe("devops-ci"); // no stats at all
  });

  test("--target / --untarget CLI lifecycle (end-to-end)", () => {
    const sd = td();
    expect(runCli(["--target"], sd)).toContain("No growth targets");
    expect(runCli(["--target", "Bad_ID!"], sd)).toContain("Invalid concept id");
    expect(runCli(["--target", "devops-ci"], sd)).toContain("Growth target added");
    expect(runCli(["--target", "devops-ci"], sd)).toContain("already");
    expect(runCli(["--target"], sd)).toContain("devops-ci");
    expect(runCli(["--untarget", "regex"], sd)).toContain("not a growth target");
    expect(runCli(["--untarget", "devops-ci"], sd)).toContain("removed");
    expect(runCli(["--target"], sd)).toContain("No growth targets");
  });
});

// ---------- Group 13: auto-difficulty ----------

describe("difficulty", () => {
  const S = (attempts: number, avg: number): ConceptStat => ({
    attempts, avg, recentAvg: avg, prevAvg: null, lastComfort: null, lastSelfTs: null,
  });

  test("truth table", () => {
    const none = new Map<string, ConceptClass>();
    const noT = new Set<string>();
    const noS = new Map<string, ConceptStat>();
    expect(difficultyFor([], none, noT, noS)).toBe("standard"); // no concepts
    expect(difficultyFor(["regex"], new Map([["regex", "struggling" as ConceptClass]]), noT, noS)).toBe("foundation");
    expect(difficultyFor(["regex"], none, new Set(["regex"]), noS)).toBe("foundation"); // targeted, 0 attempts
    expect(difficultyFor(["regex"], new Map([["regex", "strength" as ConceptClass]]), new Set(["regex"]), new Map([["regex", S(5, 2)]]))).toBe("mastery"); // targeted but proven
    expect(
      difficultyFor(
        ["regex", "testing"],
        new Map<string, ConceptClass>([["regex", "strength"], ["testing", "learning"]]),
        noT,
        noS,
      ),
    ).toBe("standard"); // mixed
    expect(
      difficultyFor(["regex"], new Map([["regex", "strength" as ConceptClass]]), noT, noS),
    ).toBe("mastery");
  });

  test("prompt carries the difficulty directive", () => {
    const args = {
      file: "x.ts", hunk: "@@ +1 @@\n+x", shortSha: "abcd1234",
      gapsPath: "/g/gaps.jsonl", scriptPath: "/g/gate.ts", bunPath: "/bin/bun",
      concepts: ["regex"], probe: null,
    };
    expect(buildGatePrompt({ ...args, difficulty: "foundation" })).toContain("DIFFICULTY: FOUNDATION");
    expect(buildGatePrompt({ ...args, difficulty: "mastery" })).toContain("what breaks if");
    expect(buildGatePrompt({ ...args, difficulty: "standard" })).not.toContain("DIFFICULTY:");
    expect(buildGatePrompt(args)).toContain("load-bearing"); // quality rule upgrade
  });

  test("prompt log line carries repo and via", () => {
    const p = buildGatePrompt({
      file: "x.ts", hunk: "h", shortSha: "abcd1234", gapsPath: "/g/gaps.jsonl",
      scriptPath: "/g/gate.ts", bunPath: "/bin/bun", concepts: [], probe: null,
      repo: "myrepo", via: "quiz",
    });
    expect(p).toContain('"repo":"myrepo","via":"quiz"');
  });
});

// ---------- Group 14: quiet hours ----------

describe("quiet hours", () => {
  const at = (daysAgo: number, hour: number, skipped: boolean, via?: string) => ({
    ts: daysAgoIso(daysAgo, hour), sha: "a", file: "x.ts", score: skipped ? null : 2,
    missed: "", skipped, concepts: [], ...(via ? { via } : {}),
  });

  test("3+ entries at 75%+ skip rate marks the hour quiet; quiz skips excluded", () => {
    expect(quietHours([at(1, 23, true), at(2, 23, true)]).has(23)).toBe(false); // only 2 samples
    expect(quietHours([at(1, 23, true), at(2, 23, true), at(3, 23, true)]).has(23)).toBe(true);
    expect(quietHours([at(1, 23, true), at(2, 23, true), at(3, 23, true), at(4, 23, false)]).has(23)).toBe(true); // 3/4
    expect(
      quietHours([at(1, 23, true), at(2, 23, true), at(3, 23, false), at(4, 23, false)]).has(23),
    ).toBe(false); // 50%
    expect(
      quietHours([at(1, 23, true, "quiz"), at(2, 23, true, "quiz"), at(3, 23, true, "quiz")]).has(23),
    ).toBe(false); // quiz-only never teaches quiet
  });

  test("governor honors quiet hours", () => {
    const quiet = new Set([ANCHOR.getHours()]);
    expect(governorAllows({ ...DEFAULT_STATE }, "s1", ANCHOR, quiet)).toBe(true);
    expect(governorAllows({ ...DEFAULT_STATE }, "s1", ANCHOR, new Set())).toBe(false);
  });

  test("progress report surfaces quiet hours", () => {
    const gaps = [at(1, 23, true), at(2, 23, true), at(3, 23, true)];
    expect(progressReport(gaps, ANCHOR)).toContain("Quiet hours");
    expect(progressReport(gaps, ANCHOR)).toContain("23:00");
  });
});

// ---------- Group 15: drill-down + repo profile ----------

describe("drill-down & repo", () => {
  const entry = (daysAgo: number, file: string, score: number, repo: string, missed = "") => ({
    ts: daysAgoIso(daysAgo), sha: "a", file, score, missed, skipped: false, concepts: ["regex"], repo,
  });

  test("drill-down shows class, trend, entries; unknown concept lists vocabulary", () => {
    const gaps = [
      entry(2, "a.ts", 0, "repo-a", "greedy quantifier"),
      entry(1, "b.ts", 1, "repo-b"),
      { type: "self", ts: daysAgoIso(0), concept: "regex", comfort: 2 },
    ];
    const out = drillDown(gaps, "regex");
    expect(out).toContain("regular expressions");
    expect(out).toContain("class: struggling");
    expect(out).toContain("Trend: ▁▄");
    expect(out).toContain("repo-a · a.ts · 0/2 · missed: greedy quantifier");
    expect(out).toContain("self-rating 2/5");
    expect(drillDown(gaps, "nonexistent-thing")).toContain("Vocabulary:");
  });

  test("drill-down resolves by label and marks growth targets", () => {
    const gaps = [
      entry(1, "a.ts", 2, "r"),
      { type: "target", ts: daysAgoIso(0), concept: "regex", on: true },
    ];
    expect(drillDown(gaps, "regular expressions")).toContain("GROWTH TARGET");
  });

  test("--progress --repo filters; global report lists repos", () => {
    const gaps = [entry(2, "a.ts", 2, "repo-a"), entry(1, "b.ts", 0, "repo-b")];
    const global = progressReport(gaps, ANCHOR);
    expect(global).toContain("Repos:");
    expect(global).toContain("repo-a (1, pass 100%)");
    const scoped = progressReport(gaps, ANCHOR, "repo-a");
    expect(scoped).toContain("[repo: repo-a]");
    expect(scoped).toContain("1 gates");
    expect(scoped).not.toContain("Repos:");
  });

  test("progress shows growth targets with and without data", () => {
    const gaps = [
      entry(1, "a.ts", 1, "r"),
      { type: "target", ts: daysAgoIso(0), concept: "regex", on: true },
      { type: "target", ts: daysAgoIso(0), concept: "devops-ci", on: true },
    ];
    const out = progressReport(gaps, ANCHOR);
    expect(out).toContain("Growth targets:");
    expect(out).toContain("regular expressions (1.0 avg, 1×)");
    expect(out).toContain("CI/CD & workflows (no data yet)");
  });
});

// ---------- Group 16: debt + statusline + knowledge page ----------

describe("debt & exports", () => {
  test("debtWeight decay boundaries", () => {
    expect(debtWeight(daysAgoIso(10), ANCHOR)).toBe(1);
    expect(debtWeight(daysAgoIso(60), ANCHOR)).toBe(0.5);
    expect(debtWeight(daysAgoIso(120), ANCHOR)).toBe(0);
    expect(debtWeight("garbage", ANCHOR)).toBe(0);
  });

  test("--debt end-to-end: coverage per dir, stale marking", () => {
    const { repo } = initRepo(); // has a.ts tracked, repo name = basename
    const repoName = repo.split("/").pop() as string;
    const sd = td();
    writeFileSync(
      join(sd, "gaps.jsonl"),
      JSON.stringify({ ts: daysAgoIso(0), sha: "x", file: "a.ts", score: 2, missed: "", skipped: false, concepts: [], repo: repoName }) + "\n",
    );
    const r = spawnSync(process.execPath, [GATE, "--debt"], {
      cwd: repo, encoding: "utf8", env: { ...process.env, GATE_STATE_DIR: sd },
    });
    expect(r.stdout).toContain("Comprehension debt");
    expect(r.stdout).toContain("100% explained");
  });

  test("--debt outside a git repo says so", () => {
    const r = spawnSync(process.execPath, [GATE, "--debt"], {
      cwd: td(), encoding: "utf8", env: { ...process.env, GATE_STATE_DIR: td() },
    });
    expect(r.stdout).toContain("Not a git repo");
  });

  test("statusline segment: streak always visible, focus when known", () => {
    expect(statuslineSegment([], ANCHOR)).toBe("🔥0d"); // never invisible
    const gaps = [
      { ts: daysAgoIso(0, 10), sha: "a", file: "x.ts", score: 2, missed: "", skipped: false, concepts: ["regex"] },
      { ts: daysAgoIso(1, 10), sha: "b", file: "y.ts", score: 0, missed: "", skipped: false, concepts: ["regex"] },
      { ts: daysAgoIso(2, 10), sha: "c", file: "z.ts", score: 0, missed: "", skipped: false, concepts: ["regex"] },
    ];
    const seg = statuslineSegment(gaps, ANCHOR);
    expect(seg).toContain("🔥1d"); // only today qualifies (score 2)
    expect(seg).toContain("regular expressions"); // struggling focus
    const targeted = statuslineSegment([...gaps, { type: "target", ts: daysAgoIso(0), concept: "devops-ci", on: true }], ANCHOR);
    expect(targeted).toContain("CI/CD & workflows"); // target outranks struggling
  });

  test("isoWeek is stable across a week boundary", () => {
    expect(isoWeek(new Date(2026, 0, 1))).toMatch(/^\d{4}-W\d{2}$/);
    expect(isoWeek(new Date(2026, 6, 13))).toBe(isoWeek(new Date(2026, 6, 19))); // Mon..Sun same week
  });

  test("knowledge page: sections present; empty log handled", () => {
    expect(knowledgePage([], ANCHOR)).toContain("No data yet");
    const gaps = [
      { ts: daysAgoIso(10), sha: "a", file: "s1.ts", score: 2, missed: "", skipped: false, concepts: ["error-handling"], repo: "r1" },
      { ts: daysAgoIso(8), sha: "b", file: "s2.ts", score: 2, missed: "", skipped: false, concepts: ["error-handling"], repo: "r1" },
      { ts: daysAgoIso(5), sha: "c", file: "s3.ts", score: 2, missed: "", skipped: false, concepts: ["error-handling"], repo: "r2" },
      { ts: daysAgoIso(1), sha: "d", file: "w.ts", score: 0, missed: "lazy match", skipped: false, concepts: ["regex"], repo: "r1" },
      { ts: daysAgoIso(0), sha: "e", file: "w2.ts", score: 0, missed: "", skipped: false, concepts: ["regex"], repo: "r1" },
      { type: "target", ts: daysAgoIso(2), concept: "devops-ci", on: true },
    ];
    const page = knowledgePage(gaps, ANCHOR);
    expect(page).toContain("## Strengths");
    expect(page).toContain("error handling");
    expect(page).toContain("## Growth targets");
    expect(page).toContain("no attempts since targeting yet");
    expect(page).toContain("## Weekly progress");
    expect(page).toContain("## Pushing against");
    expect(page).toContain("last missed: lazy match");
    expect(page).toContain("## Repos");
  });

  test("--export-md writes the page (end-to-end)", () => {
    const sd = td();
    const out = runCli(["--export-md"], sd);
    expect(out).toContain("Wrote");
    expect(readFileSync(join(sd, "KNOWLEDGE.md"), "utf8")).toContain("No data yet");
  });
});

// ---------- Group 17: /quiz ----------

describe("quiz", () => {
  function runQuiz(cwd: string, sd: string, arg?: string) {
    const args = arg ? [GATE, "--quiz", arg] : [GATE, "--quiz"];
    const r = spawnSync(process.execPath, args, {
      cwd, encoding: "utf8", env: { ...process.env, GATE_STATE_DIR: sd },
    });
    return (r.stdout ?? "").trim();
  }

  test("riskiestWindow picks the dense window and caps size", () => {
    const calm = Array.from({ length: 30 }, (_, i) => `const a${i} = ${i};`);
    const dense = [
      "export function risky(x: number) {",
      "  try { if (x) { throw new Error('x'); } } catch (e) { return -1; }",
      "  for (let i = 0; i < x; i++) { if (i % 2) continue; }",
      "  return 0;",
      "}",
    ];
    const w = riskiestWindow([...calm, ...calm, ...dense], "x.ts");
    expect(w).toBeTruthy();
    expect(w!.text.split("\n")[0]).toMatch(/^@@ x\.ts:\d+-\d+ @@$/);
    expect(w!.end - w!.start).toBeLessThanOrEqual(50);
    expect(w!.concepts).toContain("error-handling");
    expect(riskiestWindow([], "x.ts")).toBeNull();
  });

  test("quiz on a file prints the gate prompt with via:quiz, bypassing snooze", () => {
    const { repo } = initRepo();
    const sd = td();
    seedState(sd, { snooze_until: new Date(Date.now() + 3600_000).toISOString(), daily_count: 3, day: localDay(new Date()) });
    writeFileSync(join(repo, "risky.ts"), RISKY);
    const out = runQuiz(repo, sd, "risky.ts");
    expect(out).toContain("COMPREHENSION GATE");
    expect(out).toContain('"via":"quiz"');
    expect(out).toContain("risky.ts");
    const { state } = readState(sd);
    expect(state.last_gate_ts).toBeTruthy(); // gap timer set
    expect(state.daily_count).toBe(3); // untouched
  });

  test("quiz with no arg uses the current diff", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    writeFileSync(join(repo, "risky.ts"), RISKY);
    expect(runQuiz(repo, sd)).toContain("COMPREHENSION GATE");
  });

  test("quiz on a directory picks the riskiest file", () => {
    const { repo } = initRepo();
    const sd = td();
    spawnSync("mkdir", ["-p", join(repo, "src")]);
    writeFileSync(join(repo, "src", "calm.ts"), "export const x = 1;\n");
    writeFileSync(join(repo, "src", "risky.ts"), RISKY);
    sh(repo, ["git", "add", "-A"]);
    const out = runQuiz(repo, sd, "src");
    expect(out).toContain("COMPREHENSION GATE");
    expect(out).toContain("src/risky.ts");
  });

  test("config-driven quiz unaffected by governor knobs", () => {
    // sanity anchor for group 18: quiz already bypasses governor regardless of config
    const { repo } = initRepo();
    const sd = td();
    writeFileSync(join(sd, "config.json"), JSON.stringify({ daily_cap: 1 }));
    writeFileSync(join(repo, "risky.ts"), RISKY);
    expect(runQuiz(repo, sd, "risky.ts")).toContain("COMPREHENSION GATE");
  });

  test("degenerate inputs get friendly messages", () => {
    const { repo } = initRepo();
    const sd = td();
    expect(runQuiz(repo, sd, "nope.ts")).toContain("No such path");
    writeFileSync(join(repo, "empty.ts"), "");
    expect(runQuiz(repo, sd, "empty.ts")).toContain("empty");
    writeFileSync(join(repo, "bin.ts"), "abc\0def");
    expect(runQuiz(repo, sd, "bin.ts")).toContain("binary");
    writeFileSync(join(repo, "deps.lock"), "x");
    expect(runQuiz(repo, sd, "deps.lock")).toContain("not a quizzable");
    expect(runQuiz(repo, sd)).toContain("Nothing to quiz"); // clean tree, single commit → no diff
  });
});

// ---------- Group 18: config (strictness / frequency) ----------

describe("config", () => {
  test("readConfig: missing → defaults; partial merges; clamps; corrupt → defaults", () => {
    expect(readConfig(td())).toEqual(DEFAULT_CONFIG);
    const sd = td();
    writeFileSync(join(sd, "config.json"), JSON.stringify({ daily_cap: 10 }));
    expect(readConfig(sd)).toEqual({ ...DEFAULT_CONFIG, daily_cap: 10 });
    writeFileSync(join(sd, "config.json"), JSON.stringify({ daily_cap: 999, min_gap_minutes: -5, per_session: 2.7 }));
    const c = readConfig(sd);
    expect(c.daily_cap).toBe(50);
    expect(c.min_gap_minutes).toBe(0);
    expect(c.per_session).toBe(3);
    writeFileSync(join(sd, "config.json"), "{{{ nope");
    expect(readConfig(sd)).toEqual(DEFAULT_CONFIG);
    writeFileSync(join(sd, "config.json"), JSON.stringify({ daily_cap: "lots" }));
    expect(readConfig(sd)).toEqual(DEFAULT_CONFIG); // wrong type ignored
  });

  test("governor honors custom caps, gap, and per-session budget", () => {
    const now = ANCHOR;
    const cfg = { ...DEFAULT_CONFIG, daily_cap: 6, min_gap_minutes: 10, per_session: 2 };
    const capped = { ...DEFAULT_STATE, daily_count: 3, day: localDay(now) };
    expect(governorAllows(capped, "s2", now, undefined, cfg)).toBe(false); // 3 < 6 now fine
    expect(governorAllows({ ...capped, daily_count: 6 }, "s2", now, undefined, cfg)).toBe(true);
    const gap15 = { ...DEFAULT_STATE, last_gate_ts: new Date(now.getTime() - 15 * 60_000).toISOString() };
    expect(governorAllows(gap15, "s2", now, undefined, cfg)).toBe(false); // 15min > 10min gap
    expect(governorAllows(gap15, "s2", now)).toBe(true); // default 45min still blocks
    const oneFired = { ...DEFAULT_STATE, session_marker: "s1", session_count: 1 };
    expect(governorAllows(oneFired, "s1", now, undefined, cfg)).toBe(false); // budget of 2, 1 spent
    expect(governorAllows({ ...oneFired, session_count: 2 }, "s1", now, undefined, cfg)).toBe(true);
    expect(governorAllows(oneFired, "s1", now)).toBe(true); // default per_session 1
  });

  test("nextStateOnFire counts per-session; readState back-fills old files", () => {
    const first = nextStateOnFire({ ...DEFAULT_STATE }, "s1", "sha", "d1", ANCHOR);
    expect(first.session_count).toBe(1);
    const second = nextStateOnFire(first, "s1", "sha", "d2", ANCHOR);
    expect(second.session_count).toBe(2);
    const newSession = nextStateOnFire(second, "s2", "sha", "d3", ANCHOR);
    expect(newSession.session_count).toBe(1);
    const sd = td();
    writeFileSync(join(sd, "state.json"), JSON.stringify({ session_marker: "old" })); // pre-upgrade file
    expect(readState(sd).state.session_count).toBe(1);
  });

  test("per_session 2 + zero gap allows a second gate in the same session (end-to-end)", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    writeFileSync(join(sd, "config.json"), JSON.stringify({ per_session: 2, min_gap_minutes: 0 }));
    writeFileSync(join(repo, "risky.ts"), RISKY);
    expectBlock(runGate(baseInput(repo, "s1"), sd).stdout);
    appendFileSync(join(repo, "risky.ts"), "export function extra(n: number) {\n  if (n) { return n; }\n  return 0;\n}\n");
    expectBlock(runGate(baseInput(repo, "s1"), sd).stdout); // second gate, same session
    appendFileSync(join(repo, "risky.ts"), "export function extra2(n: number) {\n  if (n) { return n; }\n  return 0;\n}\n");
    expect(runGate(baseInput(repo, "s1"), sd).stdout).toBe(""); // budget of 2 spent
  });

  test("fire_threshold from config gates the scorer (end-to-end)", () => {
    const { repo, sha } = initRepo();
    const sd = td();
    seedState(sd, { last_sha: sha });
    writeFileSync(join(sd, "config.json"), JSON.stringify({ fire_threshold: 50 }));
    writeFileSync(join(repo, "risky.ts"), RISKY); // scores well above 5, below 50
    expect(runGate(baseInput(repo), sd).stdout).toBe("");
  });

  test("--config CLI: list, set, clamp note, preset, reset, unknown key", () => {
    const sd = td();
    expect(runCli(["--config"], sd)).toContain("daily_cap = 3 (default)");
    expect(runCli(["--config", "daily_cap", "8"], sd)).toContain("daily_cap = 8");
    expect(runCli(["--config"], sd)).toContain("daily_cap = 8 (default 3)");
    expect(runCli(["--config", "daily_cap"], sd)).toBe("daily_cap = 8");
    expect(runCli(["--config", "min_gap_minutes", "9999"], sd)).toContain("clamped");
    expect(runCli(["--config", "nonsense", "1"], sd)).toContain("Unknown key");
    expect(runCli(["--config", "daily_cap", "many"], sd)).toContain("not a number");
    expect(runCli(["--config", "preset", "drill-sergeant"], sd)).toContain("daily_cap=12");
    expect(readConfig(sd).min_gap_minutes).toBe(10);
    expect(runCli(["--config", "preset", "nope"], sd)).toContain("Unknown preset");
    expect(runCli(["--config", "reset"], sd)).toContain("reset");
    expect(readConfig(sd)).toEqual(DEFAULT_CONFIG);
  });
});
