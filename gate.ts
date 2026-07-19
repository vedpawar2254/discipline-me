#!/usr/bin/env bun
// Comprehension Gate — Claude Code Stop hook.
// Fires a comprehension quiz on the riskiest hunk of the diff you just accepted.
// Design: ~/.gstack/projects/gstack/vedpawar2254-main-design-20260719-165949.md
//
// Contract: this script must NEVER break a stop. Every error path allows (exit 0,
// no output). Block only via {"decision":"block","reason":...} on stdout.
//
// Modes:
//   (stdin JSON)  — Stop hook invocation
//   --status      — print "<N>-day streak · <M> files explained" from gaps.jsonl
//   --snooze      — set snooze_until to local midnight (no gates for rest of day)
//
// Env:
//   GATE_STATE_DIR          — override state dir (tests); default ~/.claude/comprehension-gate
//   COMPREHENSION_GATE_OFF  — "1" disables the gate entirely (kill switch)

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- state ----------

export interface GateState {
  last_sha: string | null;
  last_gated_digest: string | null;
  session_marker: string | null; // "gate ATTEMPTED this session" — not completed
  daily_count: number;
  day: string | null; // local YYYY-MM-DD
  last_gate_ts: string | null; // ISO8601
  snooze_until: string | null; // ISO8601
}

export const DEFAULT_STATE: GateState = {
  last_sha: null,
  last_gated_digest: null,
  session_marker: null,
  daily_count: 0,
  day: null,
  last_gate_ts: null,
  snooze_until: null,
};

const DAILY_CAP = 3;
const MIN_GAP_MS = 45 * 60 * 1000;
const FIRE_THRESHOLD = 5;
const MAX_HUNK_LINES = 50;
const MAX_HUNK_CHARS = 4000;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_BYTES = 256 * 1024;
const MAX_GIT_BUFFER = 10 * 1024 * 1024;

export function stateDir(): string {
  return process.env.GATE_STATE_DIR || join(homedir(), ".claude", "comprehension-gate");
}

export function readState(dir: string): { state: GateState; corrupt: boolean } {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "state.json"), "utf8");
  } catch {
    return { state: { ...DEFAULT_STATE }, corrupt: false }; // missing → defaults, proceed
  }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return { state: { ...DEFAULT_STATE, ...v }, corrupt: false };
  } catch {
    return { state: { ...DEFAULT_STATE }, corrupt: true }; // corrupt → repair + allow
  }
}

export function writeStateAtomic(dir: string, state: GateState): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "state.json");
  const tmp = join(dir, `state.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, target);
}

// ---------- gaps log ----------

export interface GapEntry {
  ts?: string;
  sha?: string;
  file?: string;
  score?: number | null;
  missed?: string;
  skipped?: boolean;
}

export function readGaps(dir: string): GapEntry[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "gaps.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: GapEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") out.push(v);
    } catch {
      // corrupt line: skip it, keep scanning
    }
  }
  return out;
}

// ---------- guards ----------

// true = allow the stop (never gate this turn)
export function guardsAllow(input: unknown): boolean {
  if (!input || typeof input !== "object") return true;
  const i = input as Record<string, unknown>;
  if (i.stop_hook_active === true) return true; // prevents re-fire loop
  if (i.permission_mode === "plan") return true; // no code accepted while planning
  if (i.stop_reason !== undefined && i.stop_reason !== "end_turn") return true; // truncated/abnormal stop
  if (typeof i.session_id !== "string" || i.session_id === "") return true; // no session accounting possible
  return false;
}

// ---------- governor (annoyance budget) ----------

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localMidnight(now: Date): string {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

// true = allow (governor suppresses the gate)
export function governorAllows(state: GateState, sessionId: string, now: Date): boolean {
  if (state.session_marker === sessionId) return true; // once per session (attempted counts)
  if (state.day === localDay(now) && state.daily_count >= DAILY_CAP) return true;
  if (state.last_gate_ts) {
    const t = Date.parse(state.last_gate_ts);
    if (!Number.isNaN(t) && now.getTime() - t < MIN_GAP_MS) return true; // 45-min gap (future ts ⇒ allow, fail-quiet)
  }
  if (state.snooze_until) {
    const t = Date.parse(state.snooze_until);
    if (!Number.isNaN(t) && t > now.getTime()) return true;
  }
  return false;
}

export function nextStateOnFire(
  state: GateState,
  sessionId: string,
  headSha: string,
  digest: string,
  now: Date,
): GateState {
  const today = localDay(now);
  return {
    last_sha: headSha,
    last_gated_digest: digest,
    session_marker: sessionId,
    daily_count: state.day === today ? state.daily_count + 1 : 1,
    day: today,
    last_gate_ts: now.toISOString(),
    snooze_until: state.snooze_until,
  };
}

// ---------- diff ----------

const SOURCE_EXTS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh",
  "lua", "sql", "vue", "svelte", "css", "scss", "html",
];
const INCLUDE_PATHSPECS = SOURCE_EXTS.map((e) => `*.${e}`);
// git pathspec fnmatch: '*' crosses slashes, so these match at any depth
const EXCLUDE_PATHSPECS = [
  ":(exclude)*.lock",
  ":(exclude)*.min.*",
  ":(exclude)*.d.ts",
  ":(exclude)*.generated.*",
  ":(exclude)*node_modules/*",
  ":(exclude)*dist/*",
  ":(exclude)*build/*",
  ":(exclude)*vendor/*",
];

export function isSourcePath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (!SOURCE_EXTS.includes(ext)) return false;
  if (/(^|\/)(node_modules|dist|build|vendor)\//.test(p)) return false;
  if (/\.min\.|\.d\.ts$|\.generated\./.test(p)) return false;
  return true;
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_GIT_BUFFER });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function gitNoIndex(cwd: string, file: string): string | null {
  // --no-index exits 1 when the files differ; that's the success case here
  const r = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", file], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  return r.stdout;
}

// Diff since last gate marker: committed changes AND working tree AND untracked
// source files (git diff alone ignores untracked — synthesized via --no-index).
// Any git failure → null → caller allows. The gate never breaks a stop.
export function getDiff(cwd: string, lastSha: string | null): { diff: string; headSha: string } | null {
  const headSha = git(cwd, ["rev-parse", "HEAD"])?.trim();
  if (!headSha) return null; // no commits yet / not a git repo
  const base = lastSha || "HEAD~1"; // first run: last commit + working tree
  const tracked = git(cwd, ["diff", "--diff-filter=ACM", base, "--", ...INCLUDE_PATHSPECS, ...EXCLUDE_PATHSPECS]);
  if (tracked === null) return null;
  let diff = tracked;
  const untracked = (git(cwd, ["ls-files", "--others", "--exclude-standard"]) ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isSourcePath)
    .sort()
    .slice(0, MAX_UNTRACKED_FILES);
  for (const f of untracked) {
    try {
      if (statSync(join(cwd, f)).size > MAX_UNTRACKED_BYTES) continue;
    } catch {
      continue;
    }
    const synth = gitNoIndex(cwd, f);
    if (synth) diff += (diff === "" || diff.endsWith("\n") ? "" : "\n") + synth;
  }
  return { diff, headSha };
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------- risk scorer ----------
// Placeholder weights per design (Open Question 2 — tune from week-1 gap data):
// score = 3×(new functions) + 2×(new files) + 1×(control-flow density) + 2×(file never gated)

export interface Hunk {
  header: string;
  lines: string[];
}
export interface DiffFile {
  path: string;
  isNew: boolean;
  hunks: Hunk[];
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: Hunk | null = null;
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m) {
      cur = { path: m[2], isNew: false, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode") || line.startsWith("--- /dev/null")) {
      cur.isNew = true;
      continue;
    }
    const b = line.match(/^\+\+\+ b\/(.*)$/);
    if (b && b[1] !== "dev/null") {
      cur.path = b[1]; // more reliable than the diff --git header (renames, --no-index)
      continue;
    }
    if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk) hunk.lines.push(line);
  }
  return files;
}

const FN_PATTERNS = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/,
  /^\s*(export\s+)?(const|let|var)\s+[\w$]+.*=>/,
  /^\s*(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b|else\b)[\w$]+\s*\([^)]*\)\s*\{\s*$/, // method shorthand
  /^\s*(async\s+)?def\s+\w+/,
  /^\s*(pub(\(\w+\))?\s+)?(async\s+)?fn\s+\w+/,
  /^\s*func\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/,
];
const CF_RE = /\b(if|else|elif|for|while|switch|case|try|catch|finally|except|raise|throw|await|async|defer|lock|mutex)\b/g;

function renderHunk(h: Hunk): string {
  let lines = [h.header, ...h.lines];
  let truncated = 0;
  if (lines.length > MAX_HUNK_LINES + 1) {
    truncated = lines.length - (MAX_HUNK_LINES + 1);
    lines = lines.slice(0, MAX_HUNK_LINES + 1);
  }
  let text = lines.join("\n");
  if (text.length > MAX_HUNK_CHARS) text = text.slice(0, MAX_HUNK_CHARS);
  if (truncated > 0 || text.length === MAX_HUNK_CHARS) text += `\n… (truncated)`;
  return text;
}

export function scoreDiff(
  files: DiffFile[],
  gatedFiles: Set<string>,
): { total: number; top: { file: string; text: string } | null } {
  let total = 0;
  let top: { file: string; text: string } | null = null;
  let topSel = -1;
  for (const f of files) {
    if (f.hunks.length === 0) continue;
    const fileBonus = (f.isNew ? 2 : 0) + (gatedFiles.has(f.path) ? 0 : 2);
    for (const h of f.hunks) {
      const added = h.lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
      const fn = added.filter((l) => FN_PATTERNS.some((re) => re.test(l))).length;
      let cf = 0;
      for (const l of added) cf += (l.match(CF_RE) ?? []).length;
      const hunkScore = 3 * fn + cf;
      total += hunkScore;
      const sel = hunkScore + fileBonus;
      if (sel > topSel) {
        topSel = sel;
        top = { file: f.path, text: renderHunk(h) };
      }
    }
    total += fileBonus;
  }
  return { total, top };
}

// ---------- streak / status ----------
// Streak day = local calendar day with ≥1 entry where skipped=false AND score>=1.
// N = consecutive such days ending today. Skips NEVER count. M = distinct files
// with skipped=false. Deterministic — the gate prompt delegates here.

export function computeStatus(gaps: GapEntry[], now: Date): { streak: number; files: number } {
  const qualifying = new Set<string>();
  for (const g of gaps) {
    if (g.skipped !== false) continue;
    if (typeof g.score !== "number" || g.score < 1) continue;
    if (typeof g.ts !== "string") continue;
    const t = Date.parse(g.ts);
    if (Number.isNaN(t)) continue;
    qualifying.add(localDay(new Date(t)));
  }
  let streak = 0;
  const d = new Date(now);
  while (qualifying.has(localDay(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  const files = new Set(
    gaps.filter((g) => g.skipped === false && typeof g.file === "string").map((g) => g.file as string),
  ).size;
  return { streak, files };
}

// ---------- gate prompt (T3 — five components per design) ----------

export function buildGatePrompt(o: {
  file: string;
  hunk: string;
  shortSha: string;
  gapsPath: string;
  scriptPath: string;
  bunPath: string;
}): string {
  return `COMPREHENSION GATE — the user just accepted changes they may not have digested. This turn is a comprehension check on real code from this repo. Follow the 5 steps exactly, in order.

File: ${o.file}
Base: ${o.shortSha} (working tree included)
Most comprehension-risky hunk (max 50 lines):
\`\`\`
${o.hunk}
\`\`\`

1. RETRIEVAL FIRST: ask the user to explain in 2-3 sentences what this change does and why this approach. Do NOT explain it yourself first — their retrieval attempt must come before any teaching. Ask the question, then stop and wait for their answer.
2. GRADE 0-2 against the actual hunk above: 2 = mechanism + why; 1 = what but not why; 0 = vague. You MUST cite one concrete thing from the hunk the user did not mention. "Great answer!" without a citation is a failed grading.
3. TEACH: fill their gaps in at most 3 short beats, then ask ONE Socratic question targeting their weakest spot.
4. ESCAPE HATCHES — honor instantly, zero commentary, zero persuasion:
   - "skip": end the gate now, log as skipped (step 5), done.
   - "snooze": end the gate now, run \`${o.bunPath} ${o.scriptPath} --snooze\` via Bash (no more gates until local midnight), then log as skipped (step 5).
5. LOG + STATUS (always — completed, skipped, or snoozed): append exactly ONE line to ${o.gapsPath} via Bash:
   completed: {"ts":"<ISO8601 now>","sha":"<full HEAD sha>","file":"${o.file}","score":<0|1|2>,"missed":"<one concrete thing they did not mention>","skipped":false}
   skipped/snoozed: {"ts":"<ISO8601 now>","sha":"<full HEAD sha>","file":"${o.file}","score":null,"missed":"","skipped":true}
   Then run \`${o.bunPath} ${o.scriptPath} --status\` via Bash and print: Gate <passed|skipped> · <its output>. Streaks are computed by that command (deterministic; skips never count) — do not compute them yourself.`;
}

// ---------- main ----------

async function main(): Promise<void> {
  const arg = process.argv[2];
  const dir = stateDir();

  if (arg === "--status") {
    const { streak, files } = computeStatus(readGaps(dir), new Date());
    console.log(`${streak}-day streak · ${files} files explained`);
    return;
  }
  if (arg === "--snooze") {
    const { state } = readState(dir);
    const until = localMidnight(new Date());
    try {
      writeStateAtomic(dir, { ...state, snooze_until: until });
    } catch {}
    console.log(`Snoozed until ${until}`);
    return;
  }

  if (process.env.COMPREHENSION_GATE_OFF === "1") return;

  let input: unknown;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    return; // malformed stdin → allow
  }
  if (guardsAllow(input)) return;
  const sessionId = (input as Record<string, unknown>).session_id as string;
  const cwdRaw = (input as Record<string, unknown>).cwd;
  const cwd = typeof cwdRaw === "string" && cwdRaw !== "" ? cwdRaw : process.cwd();

  const { state, corrupt } = readState(dir);
  if (corrupt) {
    try {
      writeStateAtomic(dir, state); // repair to defaults so future gates can run
    } catch {}
    return; // never block on broken state
  }

  const now = new Date();
  if (governorAllows(state, sessionId, now)) return;

  const d = getDiff(cwd, state.last_sha);
  if (!d || d.diff.trim() === "") return;
  const digest = sha256(d.diff);
  if (digest === state.last_gated_digest) return; // same dirty tree across sessions

  const gaps = readGaps(dir);
  const gated = new Set(gaps.map((g) => (typeof g.file === "string" ? g.file : "")).filter(Boolean));
  const { total, top } = scoreDiff(parseDiff(d.diff), gated);
  if (total < FIRE_THRESHOLD || !top) return;

  // State write MUST precede the block decision: if we can't record the gate,
  // we don't fire (a crash here must never double-fire).
  try {
    writeStateAtomic(dir, nextStateOnFire(state, sessionId, d.headSha, digest, now));
  } catch {
    return;
  }

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: buildGatePrompt({
        file: top.file,
        hunk: top.text,
        shortSha: d.headSha.slice(0, 8),
        gapsPath: join(dir, "gaps.jsonl"),
        scriptPath: import.meta.path,
        bunPath: process.execPath,
      }),
    }),
  );
}

if (import.meta.main) {
  main().catch(() => {}); // the gate never breaks a stop
}
