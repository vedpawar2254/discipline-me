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
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  concepts?: string[]; // vocabulary ids present in the quizzed hunk
  type?: string; // "self" = calibration probe answer, absent = gate entry
  concept?: string; // self entries: which concept was rated
  comfort?: number; // self entries: 1-5 self-rating
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

// Definitive targeting filter (tracked diffs are filtered through this too, not
// just pathspecs). Config/boilerplate files are excluded on purpose: a gate on
// "what does this config value mean" is a bullshit question, not comprehension.
export function isSourcePath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (!SOURCE_EXTS.includes(ext)) return false;
  if (/(^|\/)(node_modules|dist|build|vendor)\//.test(p)) return false;
  if (/\.min\.|\.d\.ts$|\.generated\./.test(p)) return false;
  const base = p.split("/").pop() ?? p;
  if (base.startsWith(".")) return false; // dotfiles: .eslintrc.js, .prettierrc.cjs, ...
  if (/\.(config|conf|rc)\.\w+$/.test(base)) return false; // vite.config.ts, tailwind.config.js, ...
  if (/(^|\/)(config|configs|settings)\//.test(p)) return false;
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
  conceptClasses?: Map<string, ConceptClass>,
  badqConcepts?: Set<string>,
): { total: number; top: { file: string; text: string; concepts: string[] } | null } {
  let total = 0;
  let top: { file: string; text: string; concepts: string[] } | null = null;
  let topSel = -1;
  for (const f of files) {
    if (f.hunks.length === 0) continue;
    const fileBonus = (f.isNew ? 2 : 0) + (gatedFiles.has(f.path) ? 0 : 2);
    for (const h of f.hunks) {
      const added = h.lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
      const fn = added.filter((l) => FN_PATTERNS.some((re) => re.test(l))).length;
      let cf = 0;
      for (const l of added) cf += (l.match(CF_RE) ?? []).length;
      let hunkScore = 3 * fn + cf;
      const concepts = detectConcepts(added, f.path);
      if (concepts.length > 0) {
        if (badqConcepts && concepts.some((c) => badqConcepts.has(c))) {
          hunkScore = Math.max(0, hunkScore - 2); // user flagged this kind of question as pointless
        } else if (conceptClasses) {
          const classes = concepts.map((c) => conceptClasses.get(c) ?? "learning");
          if (classes.includes("struggling")) hunkScore += 2; // steer toward weak spots
          else if (classes.every((c) => c === "strength")) hunkScore = Math.max(0, hunkScore - 2); // stop quizzing mastery
        }
      }
      total += hunkScore;
      const sel = hunkScore + fileBonus;
      if (sel > topSel) {
        topSel = sel;
        top = { file: f.path, text: renderHunk(h), concepts };
      }
    }
    total += fileBonus;
  }
  return { total, top };
}

// ---------- concept model (knowledge tracking) ----------
// Fixed vocabulary. Detection is deterministic (regex over added lines) so the
// same hunk always tags the same concepts; Claude copies the tags into the log
// line verbatim. Aggregation is event-sourced from gaps.jsonl — no extra state.

export interface Concept {
  id: string;
  label: string;
  res: RegExp[];
  exts?: string[]; // file extensions that imply the concept on their own
}

export const CONCEPTS: Concept[] = [
  { id: "async-concurrency", label: "async & concurrency", res: [/\b(async|await|Promise|setTimeout|setInterval|goroutine|threading|Mutex|mutex|semaphore)\b/] },
  { id: "error-handling", label: "error handling", res: [/\b(try|catch|except|raise|throw|finally|panic|recover)\b|\.unwrap\(|Result</] },
  { id: "types-generics", label: "types & generics", res: [/\binterface\s+\w+|\btype\s+\w+\s*=|<[A-Z]\w*(,\s*[A-Z]\w*)*>|\bimpl\b|\btrait\b/] },
  { id: "data-structures", label: "data structures & transforms", res: [/\bnew (Map|Set)\b|\.(reduce|filter|flatMap|sort)\(|\b(defaultdict|Counter|deque)\b/] },
  { id: "regex", label: "regular expressions", res: [/new RegExp|\.match\(|\.replace\(\s*\/|\bre\.(search|match|sub|compile)\b|=~/] },
  { id: "filesystem", label: "filesystem I/O", res: [/\b(readFileSync|writeFileSync|readFile|writeFile|mkdirSync?|renameSync?|statSync?|unlinkSync?|appendFileSync?)\b|\bfs\./] },
  { id: "processes", label: "processes & signals", res: [/\b(spawnSync|spawn|execSync|exec|fork|subprocess|child_process|SIGTERM|SIGKILL|SIGINT)\b/] },
  { id: "network-http", label: "networking & HTTP", res: [/\b(fetch|axios|XMLHttpRequest|WebSocket|createServer|listen)\b|https?:\/\//] },
  { id: "sql-db", label: "SQL & databases", res: [/\b(SELECT .* FROM|INSERT INTO|CREATE TABLE|DELETE FROM)\b|\b(prisma|knex|sqlite|migration)\b/i] },
  { id: "crypto-hash", label: "crypto & hashing", res: [/\b(createHash|createHmac|sha\d+|md5|bcrypt|jwt|encrypt|decrypt)\b/i] },
  { id: "testing", label: "testing", res: [/\b(describe|test|it|expect|assert\w*|mock\w*)\s*\(/] },
  { id: "cli-shell", label: "CLI & shell", res: [/process\.argv|\bargparse\b|\bgetopts\b|\bset -e\b/], exts: ["sh", "bash", "zsh"] },
  { id: "ui-frontend", label: "UI & frontend", res: [/\b(useState|useEffect|useMemo|addEventListener|querySelector)\b|document\./, /\brender\s*\(/], exts: ["vue", "svelte", "css", "scss", "html"] },
];

export function detectConcepts(addedLines: string[], path: string): string[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const text = addedLines.join("\n");
  const out: string[] = [];
  for (const c of CONCEPTS) {
    if ((c.exts && c.exts.includes(ext)) || c.res.some((re) => re.test(text))) out.push(c.id);
  }
  return out;
}

export interface ConceptStat {
  attempts: number; // completed gate entries tagged with this concept
  avg: number; // mean score across attempts
  recentAvg: number | null; // mean of last 3 attempts
  prevAvg: number | null; // mean of attempts before the last 3
  lastComfort: number | null; // latest self-rating 1-5
  lastSelfTs: string | null;
}

export function conceptStats(gaps: GapEntry[]): Map<string, ConceptStat> {
  const scores = new Map<string, number[]>();
  const self = new Map<string, { comfort: number; ts: string }>();
  for (const g of gaps) {
    if (g.type === "self") {
      if (typeof g.concept === "string" && typeof g.comfort === "number" && typeof g.ts === "string") {
        self.set(g.concept, { comfort: g.comfort, ts: g.ts }); // last one wins (file order = time order)
      }
      continue;
    }
    if (g.skipped !== false || typeof g.score !== "number") continue;
    if (!Array.isArray(g.concepts)) continue;
    for (const c of g.concepts) {
      if (typeof c !== "string") continue;
      const list = scores.get(c) ?? [];
      list.push(g.score);
      scores.set(c, list);
    }
  }
  const out = new Map<string, ConceptStat>();
  const ids = new Set([...scores.keys(), ...self.keys()]);
  for (const id of ids) {
    const list = scores.get(id) ?? [];
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const recent = list.slice(-3);
    const prev = list.slice(0, -3);
    out.set(id, {
      attempts: list.length,
      avg: list.length ? mean(list) : 0,
      recentAvg: recent.length ? mean(recent) : null,
      prevAvg: prev.length ? mean(prev) : null,
      lastComfort: self.get(id)?.comfort ?? null,
      lastSelfTs: self.get(id)?.ts ?? null,
    });
  }
  return out;
}

export type ConceptClass = "strength" | "growing" | "struggling" | "learning";

export function classifyConcept(s: ConceptStat): ConceptClass {
  if (s.lastComfort !== null && s.lastComfort <= 2) return "struggling"; // self-report of pushing against wins
  if (s.attempts >= 2 && s.avg < 1) return "struggling";
  if (s.attempts >= 3 && s.avg >= 1.5) return "strength";
  if (s.prevAvg !== null && s.recentAvg !== null && s.recentAvg - s.prevAvg >= 0.5) return "growing";
  return "learning";
}

const PROBE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// At most ONE calibration probe per gate: a struggling concept not self-probed
// in 7 days. Prefer one present in the quizzed hunk; tie-break worst avg, then id.
export function chooseProbe(
  stats: Map<string, ConceptStat>,
  now: Date,
  hunkConcepts: string[],
): { id: string; label: string } | null {
  const eligible: { id: string; avg: number; inHunk: boolean }[] = [];
  for (const [id, s] of stats) {
    if (classifyConcept(s) !== "struggling") continue;
    if (s.lastSelfTs) {
      const t = Date.parse(s.lastSelfTs);
      if (!Number.isNaN(t) && now.getTime() - t < PROBE_COOLDOWN_MS) continue;
    }
    eligible.push({ id, avg: s.avg, inHunk: hunkConcepts.includes(id) });
  }
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => Number(b.inHunk) - Number(a.inHunk) || a.avg - b.avg || a.id.localeCompare(b.id));
  const picked = eligible[0];
  const label = CONCEPTS.find((c) => c.id === picked.id)?.label ?? picked.id;
  return { id: picked.id, label };
}

// ---------- bad-question feedback (user trains the targeting) ----------
// `--bad-q` flags the most recent gate as a pointless question. Effects:
// the flagged file is off-limits for 14 days, and any concept flagged twice
// loses its scoring boost (its hunks get -2 instead).

const BADQ_SUPPRESS_MS = 14 * 24 * 60 * 60 * 1000;

export function badqData(gaps: GapEntry[]): { files: Map<string, string>; concepts: Set<string> } {
  const files = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const g of gaps) {
    if (g.type !== "badq") continue;
    if (typeof g.file === "string" && typeof g.ts === "string") files.set(g.file, g.ts);
    if (Array.isArray(g.concepts)) {
      for (const c of g.concepts) {
        if (typeof c === "string") counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
  }
  const concepts = new Set([...counts].filter(([, n]) => n >= 2).map(([c]) => c));
  return { files, concepts };
}

export function badqSuppressed(files: Map<string, string>, path: string, now: Date): boolean {
  const ts = files.get(path);
  if (!ts) return false;
  const t = Date.parse(ts);
  return !Number.isNaN(t) && now.getTime() - t < BADQ_SUPPRESS_MS;
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

// ---------- progress report ----------

export function progressReport(gaps: GapEntry[], now: Date): string {
  const gates = gaps.filter((g) => g.type === undefined);
  const completed = gates.filter((g) => g.skipped === false && typeof g.score === "number");
  const skips = gates.filter((g) => g.skipped === true);
  const passed = completed.filter((g) => (g.score as number) >= 1);
  const { streak, files } = computeStatus(gaps, now);
  const stats = conceptStats(gaps);
  const byClass: Record<ConceptClass, string[]> = { strength: [], growing: [], struggling: [], learning: [] };
  for (const [id, s] of [...stats].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (s.attempts === 0 && s.lastComfort === null) continue;
    const label = CONCEPTS.find((c) => c.id === id)?.label ?? id;
    const cls = classifyConcept(s);
    const bits: string[] = [];
    if (cls === "growing" && s.prevAvg !== null && s.recentAvg !== null) {
      bits.push(`${s.prevAvg.toFixed(1)} → ${s.recentAvg.toFixed(1)}`);
    } else if (s.attempts > 0) {
      bits.push(`${s.avg.toFixed(1)} avg`, `${s.attempts}×`);
    }
    if (s.lastComfort !== null) bits.push(`self ${s.lastComfort}/5`);
    byClass[cls].push(`${label} (${bits.join(", ")})`);
  }
  const seen = new Set(stats.keys());
  const unseen = CONCEPTS.filter((c) => !seen.has(c.id)).map((c) => c.label);
  const pass = completed.length ? `${Math.round((100 * passed.length) / completed.length)}%` : "n/a";
  const lines = [
    `Progress — ${gates.length} gates (${completed.length} completed, ${skips.length} skipped) · pass ${pass} · ${streak}-day streak · ${files} files`,
  ];
  if (byClass.strength.length) lines.push(`Strengths: ${byClass.strength.join(" · ")}`);
  if (byClass.growing.length) lines.push(`Growing: ${byClass.growing.join(" · ")}`);
  if (byClass.struggling.length) lines.push(`Pushing against: ${byClass.struggling.join(" · ")}`);
  if (byClass.learning.length) lines.push(`Learning: ${byClass.learning.join(" · ")}`);
  if (unseen.length) lines.push(`Not yet seen: ${unseen.join(", ")}`);
  return lines.join("\n");
}

// ---------- gate prompt (five components per design + knowledge model) ----------

export function buildGatePrompt(o: {
  file: string;
  hunk: string;
  shortSha: string;
  gapsPath: string;
  scriptPath: string;
  bunPath: string;
  concepts: string[];
  probe: { id: string; label: string } | null;
}): string {
  const conceptsJson = JSON.stringify(o.concepts);
  const labels = o.concepts.map((id) => CONCEPTS.find((c) => c.id === id)?.label ?? id);
  const conceptLine = labels.length ? `\nConcepts in this hunk: ${labels.join(", ")}` : "";
  const selfExample = `{"type":"self","ts":"<ISO8601 now>","concept":"${o.concepts[0] ?? "unknown"}","comfort":1}`;
  const probeStep = o.probe
    ? `\n6. CALIBRATION (only because "${o.probe.label}" is currently a struggle area): after step 5, ask exactly one extra question: "Quick calibration — how comfortable are you with ${o.probe.label}, 1-5?" If they answer with a number, append a second line to ${o.gapsPath}: {"type":"self","ts":"<ISO8601 now>","concept":"${o.probe.id}","comfort":<1-5>}. If they ignore it or say skip, drop it silently — never repeat the question.`
    : "";
  return `COMPREHENSION GATE — the user just accepted changes they may not have digested. This turn is a comprehension check on real code from this repo. Follow the steps exactly, in order.

File: ${o.file}
Base: ${o.shortSha} (working tree included)${conceptLine}
Most comprehension-risky hunk (max 50 lines):
\`\`\`
${o.hunk}
\`\`\`

QUESTION QUALITY RULE: every question must target mechanism, control flow, failure modes, or the why of the approach in this hunk. NEVER ask about config values, imports, boilerplate, naming, or trivia. If this hunk genuinely offers no meaningful question, treat it as a bad gate: run \`${o.bunPath} ${o.scriptPath} --bad-q\` via Bash, log as skipped (step 5), and end without quizzing.

1. RETRIEVAL FIRST: ask the user to explain in 2-3 sentences what this change does and why this approach. Do NOT explain it yourself first — their retrieval attempt must come before any teaching. Ask the question, then stop and wait for their answer.
2. GRADE 0-2 against the actual hunk above: 2 = mechanism + why; 1 = what but not why; 0 = vague. You MUST cite one concrete thing from the hunk the user did not mention. "Great answer!" without a citation is a failed grading.
3. TEACH: fill their gaps in at most 3 short beats, then ask ONE Socratic question targeting their weakest spot.
4. ESCAPE HATCHES — honor instantly, zero commentary, zero persuasion:
   - "skip": end the gate now, log as skipped (step 5), done.
   - "snooze": end the gate now, run \`${o.bunPath} ${o.scriptPath} --snooze\` via Bash (no more gates until local midnight), then log as skipped (step 5).
   - "no clue" (or any honest I-don't-know): log score 0 with missed "no clue — explained from scratch" (step 5, skipped:false), then teach from the start in simple words: what ${labels[0] ?? "this change"} is in plain language (max 3 sentences), what it does in THIS hunk (max 3 beats), one mental model or analogy. Hard cap 25 lines total — no file dumps, no re-reading the repo, use only the hunk above. Then append one extra line to ${o.gapsPath}: ${selfExample}
   - "bad question" / "bad q": run \`${o.bunPath} ${o.scriptPath} --bad-q\` via Bash, log as skipped (step 5), end. The targeting learns from this.
5. LOG + STATUS (always — completed, skipped, snoozed, no-clue, or bad-q): append exactly ONE line to ${o.gapsPath} via Bash:
   completed/no-clue: {"ts":"<ISO8601 now>","sha":"<full HEAD sha>","file":"${o.file}","score":<0|1|2>,"missed":"<one concrete thing they did not mention>","skipped":false,"concepts":${conceptsJson}}
   skipped/snoozed/bad-q: {"ts":"<ISO8601 now>","sha":"<full HEAD sha>","file":"${o.file}","score":null,"missed":"","skipped":true,"concepts":${conceptsJson}}
   Then run \`${o.bunPath} ${o.scriptPath} --status\` via Bash and print: Gate <passed|skipped> · <its output>. Streaks are computed by that command (deterministic; skips never count) — do not compute them yourself.${probeStep}`;
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
  if (arg === "--progress") {
    console.log(progressReport(readGaps(dir), new Date()));
    return;
  }
  if (arg === "--bad-q") {
    const gaps = readGaps(dir);
    const last = [...gaps].reverse().find((g) => g.type === undefined && typeof g.file === "string");
    if (!last) {
      console.log("No gate on record to flag.");
      return;
    }
    const line = JSON.stringify({
      type: "badq",
      ts: new Date().toISOString(),
      file: last.file,
      concepts: Array.isArray(last.concepts) ? last.concepts : [],
      note: process.argv.slice(3).join(" "),
    });
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "gaps.jsonl"), line + "\n");
    console.log(`Flagged bad question on ${last.file} — that file is off-limits for 14 days. Targeting adjusts.`);
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
  const gated = new Set(
    gaps.filter((g) => g.type === undefined && typeof g.file === "string").map((g) => g.file as string),
  );
  const stats = conceptStats(gaps);
  const classes = new Map<string, ConceptClass>([...stats].map(([id, s]) => [id, classifyConcept(s)]));
  const badq = badqData(gaps);
  const parsed = parseDiff(d.diff)
    .filter((f) => isSourcePath(f.path)) // definitive filter (pathspecs are an optimization)
    .filter((f) => !badqSuppressed(badq.files, f.path, now));
  const { total, top } = scoreDiff(parsed, gated, classes, badq.concepts);
  if (total < FIRE_THRESHOLD || !top) return;
  const probe = chooseProbe(stats, now, top.concepts);

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
        concepts: top.concepts,
        probe,
      }),
    }),
  );
}

if (import.meta.main) {
  main().catch(() => {}); // the gate never breaks a stop
}
