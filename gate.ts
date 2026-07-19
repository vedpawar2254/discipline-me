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
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

// ---------- state ----------

export interface GateState {
  last_sha: string | null;
  last_gated_digest: string | null;
  session_marker: string | null; // "gate ATTEMPTED this session" — not completed
  session_count: number; // gates fired this session (for per_session > 1)
  daily_count: number;
  day: string | null; // local YYYY-MM-DD
  last_gate_ts: string | null; // ISO8601
  snooze_until: string | null; // ISO8601
}

export const DEFAULT_STATE: GateState = {
  last_sha: null,
  last_gated_digest: null,
  session_marker: null,
  session_count: 0,
  daily_count: 0,
  day: null,
  last_gate_ts: null,
  snooze_until: null,
};

// ---------- config (strictness / frequency knobs) ----------
// config.json in the state dir. Missing/corrupt → defaults; values clamped.
// The gate must never break a stop because someone fat-fingered a number.

export interface GateConfig {
  daily_cap: number; // max gates per calendar day
  min_gap_minutes: number; // minimum minutes between gates
  per_session: number; // max gates per Claude session
  fire_threshold: number; // risk score needed to fire (lower = stricter)
}

export const DEFAULT_CONFIG: GateConfig = {
  daily_cap: 3,
  min_gap_minutes: 45,
  per_session: 1,
  fire_threshold: 5,
};

export const PRESETS: Record<string, GateConfig> = {
  chill: { daily_cap: 2, min_gap_minutes: 90, per_session: 1, fire_threshold: 8 },
  default: { ...DEFAULT_CONFIG },
  strict: { daily_cap: 6, min_gap_minutes: 20, per_session: 2, fire_threshold: 4 },
  "drill-sergeant": { daily_cap: 12, min_gap_minutes: 10, per_session: 3, fire_threshold: 3 },
};

const CONFIG_CLAMPS: Record<keyof GateConfig, [number, number]> = {
  daily_cap: [1, 50],
  min_gap_minutes: [0, 720],
  per_session: [1, 10],
  fire_threshold: [1, 50],
};

export function clampConfigValue(key: keyof GateConfig, n: number): number {
  const [lo, hi] = CONFIG_CLAMPS[key];
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function readConfig(dir: string): GateConfig {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "config.json"), "utf8");
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    const out = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(CONFIG_CLAMPS) as (keyof GateConfig)[]) {
      const n = (v as Record<string, unknown>)[key];
      if (typeof n === "number" && Number.isFinite(n)) out[key] = clampConfigValue(key, n);
    }
    return out;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(dir: string, c: GateConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(c, null, 2) + "\n");
}
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
    const state: GateState = { ...DEFAULT_STATE, ...v };
    // pre-session_count files: a set marker means one gate already fired this session
    if (typeof (v as Record<string, unknown>).session_marker === "string" && (v as Record<string, unknown>).session_count === undefined) {
      state.session_count = 1;
    }
    return { state, corrupt: false };
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
  type?: string; // "self" | "badq" | "target"; absent = gate entry
  concept?: string; // self/target entries: which concept
  comfort?: number; // self entries: 1-5 self-rating
  on?: boolean; // target entries: true = targeted, false = untargeted
  repo?: string; // gate entries: basename of git toplevel at fire time
  via?: string; // gate entries: "stop" (hook) | "quiz" (on-demand); absent = "stop"
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

// Learned quiet hours: local hours where the user historically skips gates.
// An hour qualifies with >=3 hook-fired gates and a skip rate >=75%. Quiz
// entries are excluded — a user-initiated quiz skip is not annoyance signal.
// No cap on how many hours can go quiet; --progress makes them visible.
export function quietHours(gaps: GapEntry[]): Set<number> {
  const buckets = new Map<number, { n: number; skips: number }>();
  for (const g of gaps) {
    if (g.type !== undefined) continue;
    if (g.via === "quiz") continue;
    if (typeof g.ts !== "string") continue;
    const t = Date.parse(g.ts);
    if (Number.isNaN(t)) continue;
    const h = new Date(t).getHours();
    const b = buckets.get(h) ?? { n: 0, skips: 0 };
    b.n++;
    if (g.skipped === true) b.skips++;
    buckets.set(h, b);
  }
  const out = new Set<number>();
  for (const [h, b] of buckets) {
    if (b.n >= 3 && b.skips / b.n >= 0.75) out.add(h);
  }
  return out;
}

// true = allow (governor suppresses the gate)
export function governorAllows(
  state: GateState,
  sessionId: string,
  now: Date,
  quiet?: Set<number>,
  config?: GateConfig,
): boolean {
  const cfg = config ?? DEFAULT_CONFIG;
  if (quiet?.has(now.getHours())) return true; // learned quiet hour
  if (state.session_marker === sessionId && state.session_count >= cfg.per_session) return true; // session budget spent
  if (state.day === localDay(now) && state.daily_count >= cfg.daily_cap) return true;
  if (state.last_gate_ts) {
    const t = Date.parse(state.last_gate_ts);
    if (!Number.isNaN(t) && now.getTime() - t < cfg.min_gap_minutes * 60_000) return true; // gap (future ts ⇒ allow, fail-quiet)
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
    session_count: state.session_marker === sessionId ? state.session_count + 1 : 1,
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
// Infra files are meaningful growth domains, not config trivia — allowlisted
// past the extension/dotfile/config exclusions. Generic *.yml stays excluded.
const INFRA_RES = [
  /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)docker-compose[^/]*\.ya?ml$/,
  /\.tf$/,
  /(^|\/)Makefile$/,
];

export function isInfraPath(p: string): boolean {
  return INFRA_RES.some((re) => re.test(p));
}

const INCLUDE_PATHSPECS = [
  ...SOURCE_EXTS.map((e) => `*.${e}`),
  ".github/workflows/*",
  "*Dockerfile*",
  "*docker-compose*",
  "*.tf",
  "*Makefile",
];
// git pathspec fnmatch: '*' crosses slashes, so these match at any depth
const EXCLUDE_PATHSPECS = [
  ":(exclude)*.lock",
  ":(exclude)*.min.*",
  ":(exclude)*.d.ts",
  ":(exclude)*.generated.*",
  ":(exclude)*node_modules*",
  ":(exclude)*dist/*",
  ":(exclude)*build/*",
  ":(exclude)*vendor/*",
];

// Definitive targeting filter (tracked diffs are filtered through this too, not
// just pathspecs). Config/boilerplate files are excluded on purpose: a gate on
// "what does this config value mean" is a bullshit question, not comprehension.
export function isSourcePath(p: string): boolean {
  if (/(^|\/)(node_modules[^/]*|dist|build|vendor|\.git)\//.test(p)) return false; // node_modules.nosync too (iCloud)
  if (isInfraPath(p)) return true; // infra domains override the dotfile/config rules below
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (!SOURCE_EXTS.includes(ext)) return false;
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

// One steering rule shared by the diff scorer and the quiz window picker:
// badq (explicit "stop this") > growth target +3 > struggling +2 > all-mastered −2.
// Boosts never stack.
export function applyConceptSteering(
  score: number,
  concepts: string[],
  classes?: Map<string, ConceptClass>,
  targets?: Set<string>,
  badqConcepts?: Set<string>,
): number {
  if (concepts.length === 0) return score;
  if (badqConcepts && concepts.some((c) => badqConcepts.has(c))) return Math.max(0, score - 2);
  if (targets && concepts.some((c) => targets.has(c))) return score + 3;
  if (classes) {
    const cl = concepts.map((c) => classes.get(c) ?? "learning");
    if (cl.includes("struggling")) return score + 2;
    if (cl.every((c) => c === "strength")) return Math.max(0, score - 2);
  }
  return score;
}

export function scoreDiff(
  files: DiffFile[],
  gatedFiles: Set<string>,
  conceptClasses?: Map<string, ConceptClass>,
  badqConcepts?: Set<string>,
  targets?: Set<string>,
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
      hunkScore = applyConceptSteering(hunkScore, concepts, conceptClasses, targets, badqConcepts);
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
  paths?: RegExp[]; // path shapes that imply the concept on their own
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
  { id: "devops-ci", label: "CI/CD & workflows", res: [/^\s*(jobs|runs-on|steps|uses|needs|workflow_dispatch|pull_request)\s*:/m, /\bactions\/[\w-]+@v?\d/], paths: [/(^|\/)\.github\/workflows\//] },
  { id: "containers", label: "containers & Docker", res: [/^\s*(FROM|RUN|COPY|EXPOSE|ENTRYPOINT|CMD|WORKDIR)\b/m, /\bdocker(-compose| build| run)\b/], paths: [/(^|\/)Dockerfile[^/]*$/, /(^|\/)docker-compose[^/]*\.ya?ml$/] },
  { id: "infra-as-code", label: "infrastructure as code", res: [/^\s*(resource|provider|module|variable|output)\s+"/m, /\bterraform\b/], paths: [/\.tf$/] },
  { id: "build-tooling", label: "build tooling & make", res: [/^\.PHONY\b/m], paths: [/(^|\/)Makefile$/] },
];

export function detectConcepts(addedLines: string[], path: string): string[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const text = addedLines.join("\n");
  const out: string[] = [];
  for (const c of CONCEPTS) {
    if (
      (c.exts && c.exts.includes(ext)) ||
      (c.paths && c.paths.some((re) => re.test(path))) ||
      c.res.some((re) => re.test(text))
    ) {
      out.push(c.id);
    }
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

// Declared growth targets — event-sourced from "target" lines, last event wins.
// A target says "push me here" regardless of what the score data shows yet.
export function activeTargets(gaps: GapEntry[]): Set<string> {
  const out = new Set<string>();
  for (const g of gaps) {
    if (g.type !== "target" || typeof g.concept !== "string") continue;
    if (g.on === false) out.delete(g.concept);
    else out.add(g.concept);
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

// At most ONE calibration probe per gate. Eligible: struggling concepts, plus
// declared growth targets (even with zero attempts — targeting says "push me").
// Priority: targeted-in-hunk → struggling-in-hunk → targeted → struggling;
// tie-break worst avg, then id. 7-day cooldown per concept via last self entry.
export function chooseProbe(
  stats: Map<string, ConceptStat>,
  now: Date,
  hunkConcepts: string[],
  targets?: Set<string>,
): { id: string; label: string } | null {
  const cooled = (s: ConceptStat | undefined): boolean => {
    if (!s?.lastSelfTs) return false;
    const t = Date.parse(s.lastSelfTs);
    return !Number.isNaN(t) && now.getTime() - t < PROBE_COOLDOWN_MS;
  };
  const ids = new Set<string>([...stats.keys(), ...(targets ?? [])]);
  const eligible: { id: string; avg: number; rank: number }[] = [];
  for (const id of ids) {
    const s = stats.get(id);
    const targeted = targets?.has(id) ?? false;
    const struggling = s ? classifyConcept(s) === "struggling" : false;
    if (!targeted && !struggling) continue;
    if (cooled(s)) continue;
    const inHunk = hunkConcepts.includes(id);
    const rank = targeted && inHunk ? 0 : struggling && inHunk ? 1 : targeted ? 2 : 3;
    eligible.push({ id, avg: s?.avg ?? -1, rank });
  }
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => a.rank - b.rank || a.avg - b.avg || a.id.localeCompare(b.id));
  const picked = eligible[0];
  const label = CONCEPTS.find((c) => c.id === picked.id)?.label ?? picked.id;
  return { id: picked.id, label };
}

// Question difficulty adapts to demonstrated understanding:
// foundation — any hunk concept struggling, or targeted with <2 attempts (user
//   declared they don't know it yet); mastery — every hunk concept a proven
//   strength; standard otherwise.
export type Difficulty = "foundation" | "standard" | "mastery";

export function difficultyFor(
  concepts: string[],
  classes: Map<string, ConceptClass>,
  targets: Set<string>,
  stats: Map<string, ConceptStat>,
): Difficulty {
  if (concepts.length === 0) return "standard";
  for (const c of concepts) {
    if (classes.get(c) === "struggling") return "foundation";
    if (targets.has(c) && (stats.get(c)?.attempts ?? 0) < 2) return "foundation";
  }
  if (concepts.every((c) => classes.get(c) === "strength")) return "mastery";
  return "standard";
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

export function progressReport(gaps: GapEntry[], now: Date, repoFilter?: string): string {
  // Repo filter keeps self/target/badq lines (they're global) and filters gate entries.
  const scoped = repoFilter
    ? gaps.filter((g) => g.type !== undefined || (g.repo ?? "unknown") === repoFilter)
    : gaps;
  const gates = scoped.filter((g) => g.type === undefined);
  const completed = gates.filter((g) => g.skipped === false && typeof g.score === "number");
  const skips = gates.filter((g) => g.skipped === true);
  const passed = completed.filter((g) => (g.score as number) >= 1);
  const { streak, files } = computeStatus(scoped, now);
  const stats = conceptStats(scoped);
  const targets = activeTargets(gaps);
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
  const scope = repoFilter ? ` [repo: ${repoFilter}]` : "";
  const lines = [
    `Progress${scope} — ${gates.length} gates (${completed.length} completed, ${skips.length} skipped) · pass ${pass} · ${streak}-day streak · ${files} files`,
  ];
  if (targets.size) {
    const t = [...targets].map((id) => {
      const label = CONCEPTS.find((c) => c.id === id)?.label ?? id;
      const s = stats.get(id);
      return s && s.attempts > 0 ? `${label} (${s.avg.toFixed(1)} avg, ${s.attempts}×)` : `${label} (no data yet)`;
    });
    lines.push(`Growth targets: ${t.join(" · ")}`);
  }
  if (byClass.strength.length) lines.push(`Strengths: ${byClass.strength.join(" · ")}`);
  if (byClass.growing.length) lines.push(`Growing: ${byClass.growing.join(" · ")}`);
  if (byClass.struggling.length) lines.push(`Pushing against: ${byClass.struggling.join(" · ")}`);
  if (byClass.learning.length) lines.push(`Learning: ${byClass.learning.join(" · ")}`);
  if (unseen.length) lines.push(`Not yet seen: ${unseen.join(", ")}`);
  const quiet = quietHours(gaps);
  if (quiet.size) {
    const hrs = [...quiet].sort((a, b) => a - b).map((h) => `${String(h).padStart(2, "0")}:00`);
    lines.push(`Quiet hours (learned from your skips): ${hrs.join(", ")}`);
  }
  if (!repoFilter) {
    const byRepo = new Map<string, { n: number; passed: number; completed: number }>();
    for (const g of gates) {
      const r = g.repo ?? "unknown";
      const b = byRepo.get(r) ?? { n: 0, passed: 0, completed: 0 };
      b.n++;
      if (g.skipped === false && typeof g.score === "number") {
        b.completed++;
        if (g.score >= 1) b.passed++;
      }
      byRepo.set(r, b);
    }
    if (byRepo.size) {
      const parts = [...byRepo]
        .sort((a, b) => b[1].n - a[1].n)
        .map(([r, b]) => `${r} (${b.n}${b.completed ? `, pass ${Math.round((100 * b.passed) / b.completed)}%` : ""})`);
      lines.push(`Repos: ${parts.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

// ---------- concept drill-down ----------

const SPARK = "▁▄█"; // score 0 / 1 / 2

export function drillDown(gaps: GapEntry[], query: string): string {
  const q = query.toLowerCase();
  const known = new Set<string>();
  for (const g of gaps) {
    if (g.type === undefined && Array.isArray(g.concepts)) {
      for (const c of g.concepts) if (typeof c === "string") known.add(c);
    }
    if ((g.type === "self" || g.type === "target") && typeof g.concept === "string") known.add(g.concept);
  }
  const vocabHit = CONCEPTS.find((c) => c.id === q || c.label.toLowerCase().includes(q));
  const id = vocabHit?.id ?? ([...known].find((k) => k.toLowerCase() === q) ?? null);
  if (!id) {
    return `No data for "${query}".\nKnown ids with data: ${[...known].sort().join(", ") || "none"}\nVocabulary: ${CONCEPTS.map((c) => c.id).join(", ")}`;
  }
  const label = CONCEPTS.find((c) => c.id === id)?.label ?? id;
  const s = conceptStats(gaps).get(id);
  const targeted = activeTargets(gaps).has(id);
  const entries = gaps.filter((g) => g.type === undefined && Array.isArray(g.concepts) && g.concepts.includes(id));
  const selfs = gaps.filter((g) => g.type === "self" && g.concept === id);
  const day = (ts: unknown) => (typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? localDay(new Date(Date.parse(ts))) : "unknown");
  const lines = [`${id} — ${label}${targeted ? " · GROWTH TARGET" : ""}`];
  if (s && s.attempts > 0) {
    const bits = [`class: ${classifyConcept(s)}`, `${s.attempts} attempts`, `${s.avg.toFixed(1)} avg`];
    if (s.lastComfort !== null) bits.push(`self ${s.lastComfort}/5`);
    lines.push(bits.join(" · "));
    const scored = entries.filter((e) => e.skipped === false && typeof e.score === "number");
    if (scored.length) lines.push(`Trend: ${scored.map((e) => SPARK[e.score as number] ?? "?").join("")}`);
  } else {
    lines.push(s?.lastComfort !== null && s !== undefined ? `class: ${classifyConcept(s)} · no graded attempts yet` : "No graded attempts yet.");
  }
  for (const e of entries.slice(-20)) {
    const score = e.skipped === true ? "skip" : `${e.score}/2`;
    const missed = e.missed ? ` · missed: ${e.missed}` : "";
    lines.push(`${day(e.ts)} · ${e.repo ?? "unknown"} · ${e.file ?? "?"} · ${score}${missed}`);
  }
  for (const e of selfs.slice(-5)) {
    lines.push(`${day(e.ts)} · self-rating ${e.comfort}/5`);
  }
  return lines.join("\n");
}

// ---------- debt meter ----------

export function debtWeight(ts: string, now: Date): number {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return 0;
  const days = (now.getTime() - t) / 86400000;
  if (days <= 30) return 1;
  if (days <= 90) return 0.5;
  return 0;
}

export function debtReport(cwd: string, gaps: GapEntry[], now: Date): string {
  const topRaw = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!topRaw) return "Not a git repo — run --debt inside one.";
  const root = topRaw.trim();
  const repo = root.split("/").pop() ?? root;
  const files = (git(root, ["ls-files"]) ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isSourcePath);
  if (files.length === 0) return "No tracked source files here.";
  const weight = new Map<string, number>();
  for (const g of gaps) {
    if (g.type !== undefined || g.skipped !== false) continue;
    if (typeof g.score !== "number" || g.score < 1) continue;
    if ((g.repo ?? "unknown") !== repo) continue;
    if (typeof g.file !== "string" || typeof g.ts !== "string") continue;
    weight.set(g.file, Math.max(weight.get(g.file) ?? 0, debtWeight(g.ts, now)));
  }
  const dirs = new Map<string, { total: number; covered: number; stale: number }>();
  let totalW = 0;
  for (const f of files) {
    const d = f.includes("/") ? `${f.split("/")[0]}/` : "./";
    const b = dirs.get(d) ?? { total: 0, covered: 0, stale: 0 };
    b.total++;
    const w = weight.get(f) ?? 0;
    b.covered += w;
    if (w === 0.5) b.stale++;
    totalW += w;
    dirs.set(d, b);
  }
  const bar = (pct: number) => "▓".repeat(Math.round(pct / 10)).padEnd(10, "░");
  const lines = [
    `Comprehension debt — ${repo}: ${Math.round((100 * totalW) / files.length)}% explained (${files.length} source files)`,
  ];
  for (const [d, b] of [...dirs].sort((x, y) => x[1].covered / x[1].total - y[1].covered / y[1].total)) {
    const pct = Math.round((100 * b.covered) / b.total);
    lines.push(`${d.padEnd(24)} ${bar(pct)} ${String(pct).padStart(3)}% (${b.covered}/${b.total}${b.stale ? `, ${b.stale} stale` : ""})`);
  }
  lines.push("Weights: explained ≤30d = 1.0 · ≤90d = 0.5 (stale) · older = 0");
  return lines.join("\n");
}

// ---------- statusline ----------

export function statuslineSegment(gaps: GapEntry[], now: Date): string {
  const { streak } = computeStatus(gaps, now);
  const targets = activeTargets(gaps);
  const stats = conceptStats(gaps);
  let focus: string | null = [...targets][0] ?? null;
  if (!focus) {
    let worst: { id: string; avg: number } | null = null;
    for (const [id, s] of stats) {
      if (classifyConcept(s) !== "struggling") continue;
      if (!worst || s.avg < worst.avg) worst = { id, avg: s.avg };
    }
    focus = worst?.id ?? null;
  }
  // Always show the flame (even 🔥0d) — an invisible statusline reads as broken.
  const bits: string[] = [`🔥${streak}d`];
  if (focus) bits.push(`▶ ${CONCEPTS.find((c) => c.id === focus)?.label ?? focus}`);
  return bits.join(" · ");
}

// ---------- knowledge page ----------

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function knowledgePage(gaps: GapEntry[], now: Date): string {
  const gates = gaps.filter((g) => g.type === undefined);
  const head = `# Knowledge — generated ${localDay(now)}\n`;
  if (gates.length === 0 && !gaps.some((g) => g.type === "self")) {
    return `${head}\nNo data yet — accept a gate first.\n`;
  }
  const stats = conceptStats(gaps);
  const targets = activeTargets(gaps);
  const label = (id: string) => CONCEPTS.find((c) => c.id === id)?.label ?? id;
  const out: string[] = [head, "## Summary\n", "```", progressReport(gaps, now), "```", ""];

  const strengths = [...stats].filter(([, s]) => classifyConcept(s) === "strength");
  if (strengths.length) {
    out.push("## Strengths (with receipts)\n");
    for (const [id, s] of strengths) {
      out.push(`- **${label(id)}** — ${s.avg.toFixed(1)} avg over ${s.attempts} attempts`);
      const receipts = gates
        .filter((g) => g.skipped === false && Array.isArray(g.concepts) && g.concepts.includes(id))
        .slice(-5);
      for (const r of receipts) {
        const d = typeof r.ts === "string" ? localDay(new Date(Date.parse(r.ts))) : "unknown";
        out.push(`  - ${d} · ${r.repo ?? "unknown"} · ${r.file ?? "?"} · ${r.score}/2`);
      }
    }
    out.push("");
  }

  if (targets.size) {
    out.push("## Growth targets\n");
    const targetTs = new Map<string, string>();
    for (const g of gaps) {
      if (g.type === "target" && g.on !== false && typeof g.concept === "string" && typeof g.ts === "string") {
        targetTs.set(g.concept, g.ts);
      }
    }
    for (const id of targets) {
      const since = targetTs.get(id);
      const sinceEntries = gates.filter(
        (g) =>
          g.skipped === false &&
          Array.isArray(g.concepts) &&
          g.concepts.includes(id) &&
          typeof g.ts === "string" &&
          (!since || g.ts >= since),
      );
      const scores = sinceEntries.map((g) => g.score as number).filter((n) => typeof n === "number");
      const prog = scores.length
        ? `${scores.length} attempts, ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)} avg since targeting`
        : "no attempts since targeting yet";
      out.push(`- **${label(id)}** (since ${since ? localDay(new Date(Date.parse(since))) : "?"}) — ${prog}`);
    }
    out.push("");
  }

  const weekly = new Map<string, number[]>();
  for (const g of gates) {
    if (g.skipped !== false || typeof g.score !== "number" || typeof g.ts !== "string") continue;
    const t = Date.parse(g.ts);
    if (Number.isNaN(t)) continue;
    const wk = isoWeek(new Date(t));
    const list = weekly.get(wk) ?? [];
    list.push(g.score);
    weekly.set(wk, list);
  }
  if (weekly.size) {
    out.push("## Weekly progress\n", "| Week | Gates | Avg score |", "|------|-------|-----------|");
    for (const [wk, scores] of [...weekly].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`| ${wk} | ${scores.length} | ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)} |`);
    }
    out.push("");
  }

  const struggling = [...stats].filter(([, s]) => classifyConcept(s) === "struggling");
  if (struggling.length) {
    out.push("## Pushing against\n");
    for (const [id, s] of struggling) {
      const lastMissed = [...gates]
        .reverse()
        .find((g) => Array.isArray(g.concepts) && g.concepts.includes(id) && g.missed);
      const note = lastMissed?.missed ? ` — last missed: ${lastMissed.missed}` : "";
      const attempts = s.attempts > 0 ? `${s.avg.toFixed(1)} avg over ${s.attempts}` : "self-rated low";
      out.push(`- **${label(id)}** — ${attempts}${note}`);
    }
    out.push("");
  }

  const byRepo = new Map<string, number>();
  for (const g of gates) byRepo.set(g.repo ?? "unknown", (byRepo.get(g.repo ?? "unknown") ?? 0) + 1);
  if (byRepo.size) {
    out.push("## Repos\n");
    for (const [r, n] of [...byRepo].sort((a, b) => b[1] - a[1])) out.push(`- ${r}: ${n} gates`);
    out.push("");
  }
  return out.join("\n");
}

// ---------- quiz window picker (on-demand /quiz) ----------

export function riskiestWindow(
  lines: string[],
  path: string,
  classes?: Map<string, ConceptClass>,
  targets?: Set<string>,
  badqConcepts?: Set<string>,
): { start: number; end: number; text: string; concepts: string[]; score: number } | null {
  if (lines.length === 0) return null;
  const step = 25;
  let best: { start: number; end: number; seg: string[]; concepts: string[]; score: number } | null = null;
  for (let i = 0; i < lines.length; i += step) {
    const seg = lines.slice(i, i + MAX_HUNK_LINES);
    const fn = seg.filter((l) => FN_PATTERNS.some((re) => re.test(l))).length;
    let cf = 0;
    for (const l of seg) cf += (l.match(CF_RE) ?? []).length;
    const concepts = detectConcepts(seg, path);
    const score = applyConceptSteering(3 * fn + cf, concepts, classes, targets, badqConcepts);
    if (!best || score > best.score) {
      best = { start: i, end: Math.min(i + MAX_HUNK_LINES, lines.length), seg, concepts, score };
    }
    if (i + MAX_HUNK_LINES >= lines.length) break;
  }
  if (!best) return null;
  let text = best.seg.join("\n");
  if (text.length > MAX_HUNK_CHARS) text = text.slice(0, MAX_HUNK_CHARS) + "\n… (truncated)";
  return {
    start: best.start,
    end: best.end,
    text: `@@ ${path}:${best.start + 1}-${best.end} @@\n${text}`,
    concepts: best.concepts,
    score: best.score,
  };
}

// ---------- gate prompt (five components per design + knowledge model) ----------

const DIFFICULTY_DIRECTIVES: Record<Difficulty, string> = {
  foundation:
    "\nDIFFICULTY: FOUNDATION — the user is new to this area (declared or demonstrated). Assume no prior vocabulary. The retrieval question asks WHAT the change does in plain terms. Teach beats define every term before using it. The Socratic question checks the core mechanism only — no edge cases, no tradeoffs.",
  standard: "",
  mastery:
    "\nDIFFICULTY: MASTERY — the user has proven these concepts. Skip the basics. Ask failure modes, edge cases, or why this approach over the obvious alternative. The Socratic question must be a 'what breaks if…' question.",
};

export function buildGatePrompt(o: {
  file: string;
  hunk: string;
  shortSha: string;
  gapsPath: string;
  scriptPath: string;
  bunPath: string;
  concepts: string[];
  probe: { id: string; label: string } | null;
  repo?: string;
  via?: "stop" | "quiz";
  difficulty?: Difficulty;
}): string {
  const repo = o.repo ?? "unknown";
  const via = o.via ?? "stop";
  const difficulty = o.difficulty ?? "standard";
  const conceptsJson = JSON.stringify(o.concepts);
  const labels = o.concepts.map((id) => CONCEPTS.find((c) => c.id === id)?.label ?? id);
  const conceptLine = labels.length ? `\nConcepts in this hunk: ${labels.join(", ")}` : "";
  const selfExample = `{"type":"self","ts":"<ISO8601 now>","concept":"${o.concepts[0] ?? "unknown"}","comfort":1}`;
  const probeStep = o.probe
    ? `\n6. CALIBRATION (only because "${o.probe.label}" is currently a growth/struggle area): after step 5, ask exactly one extra question: "Quick calibration — how comfortable are you with ${o.probe.label}, 1-5?" If they answer with a number, append a second line to ${o.gapsPath}: {"type":"self","ts":"<ISO8601 now>","concept":"${o.probe.id}","comfort":<1-5>}. If they ignore it or say skip, drop it silently — never repeat the question.`
    : "";
  return `COMPREHENSION GATE — the user just accepted changes they may not have digested. This turn is a comprehension check on real code from this repo. Follow the steps exactly, in order.

File: ${o.file}
Base: ${o.shortSha} (working tree included)${conceptLine}
Most comprehension-risky hunk (max 50 lines):
\`\`\`
${o.hunk}
\`\`\`

QUESTION QUALITY RULE: every question must target mechanism, control flow, failure modes, or the why of the approach in this hunk. Prefer the hunk's load-bearing decision — the line whose removal breaks the feature — over incidental code. NEVER ask about config values, imports, boilerplate, naming, or trivia. If this hunk genuinely offers no meaningful question, treat it as a bad gate: run \`${o.bunPath} ${o.scriptPath} --bad-q\` via Bash, log as skipped (step 5), and end without quizzing.${DIFFICULTY_DIRECTIVES[difficulty]}

1. RETRIEVAL FIRST: ask the user to explain in 2-3 sentences what this change does and why this approach. Do NOT explain it yourself first — their retrieval attempt must come before any teaching. Ask the question, then stop and wait for their answer.
2. GRADE 0-2 against the actual hunk above: 2 = mechanism + why; 1 = what but not why; 0 = vague. You MUST cite one concrete thing from the hunk the user did not mention. "Great answer!" without a citation is a failed grading.
3. TEACH: fill their gaps in at most 3 short beats, then ask ONE Socratic question targeting their weakest spot.
4. ESCAPE HATCHES — honor instantly, zero commentary, zero persuasion:
   - "skip": end the gate now, log as skipped (step 5), done.
   - "snooze": end the gate now, run \`${o.bunPath} ${o.scriptPath} --snooze\` via Bash (no more gates until local midnight), then log as skipped (step 5).
   - "no clue" (or any honest I-don't-know): log score 0 with missed "no clue — explained from scratch" (step 5, skipped:false), then teach from the start in simple words: what ${labels[0] ?? "this change"} is in plain language (max 3 sentences), what it does in THIS hunk (max 3 beats), one mental model or analogy. Hard cap 25 lines total — no file dumps, no re-reading the repo, use only the hunk above. Then append one extra line to ${o.gapsPath}: ${selfExample}
   - "bad question" / "bad q": run \`${o.bunPath} ${o.scriptPath} --bad-q\` via Bash, log as skipped (step 5), end. The targeting learns from this.
5. LOG + STATUS (always — completed, skipped, snoozed, no-clue, or bad-q): append exactly ONE line to ${o.gapsPath} via Bash:
   completed/no-clue: {"ts":"<ISO8601 now>","sha":"<full HEAD sha>","file":"${o.file}","score":<0|1|2>,"missed":"<one concrete thing they did not mention>","skipped":false,"concepts":${conceptsJson},"repo":"${repo}","via":"${via}"}
   skipped/snoozed/bad-q: {"ts":"<ISO8601 now>","sha":"<full HEAD sha>","file":"${o.file}","score":null,"missed":"","skipped":true,"concepts":${conceptsJson},"repo":"${repo}","via":"${via}"}
   Then run \`${o.bunPath} ${o.scriptPath} --status\` via Bash and print: Gate <passed|skipped> · <its output>. Streaks are computed by that command (deterministic; skips never count) — do not compute them yourself.${probeStep}`;
}

// ---------- main ----------

function appendGapLine(dir: string, obj: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "gaps.jsonl"), JSON.stringify(obj) + "\n");
}

function repoNameFor(cwd: string): string {
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  const base = (top ?? cwd).split("/").pop();
  return base || "unknown";
}

const CONCEPT_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Cheap whole-file risk score for picking the quiz file in a directory.
function cheapFileScore(absPath: string): number {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absPath);
  } catch {
    return -1;
  }
  if (!st.isFile() || st.size === 0 || st.size > MAX_UNTRACKED_BYTES) return -1;
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return -1;
  }
  if (content.includes("\0")) return -1;
  const lines = content.split("\n");
  const fn = lines.filter((l) => FN_PATTERNS.some((re) => re.test(l))).length;
  let cf = 0;
  for (const l of lines) cf += (l.match(CF_RE) ?? []).length;
  return 3 * fn + cf;
}

// Source files under dirAbs: git ls-files inside a repo, bounded walk outside.
function listSourceFiles(dirAbs: string, root: string | null): string[] {
  if (root) {
    const rel = relative(root, dirAbs);
    const raw = git(root, ["ls-files", "--", rel === "" ? "." : rel]) ?? "";
    return raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(isSourcePath)
      .map((f) => join(root, f))
      .slice(0, 200);
  }
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 6 || out.length >= 200) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 200) return;
      const p = join(d, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!/^(node_modules|dist|build|vendor|\.git)/.test(e)) walk(p, depth + 1);
      } else if (isSourcePath(relative(dirAbs, p))) {
        out.push(p);
      }
    }
  };
  walk(dirAbs, 0);
  return out;
}

const QUIZ_MAX_BYTES = 512 * 1024;

function quiz(dir: string, targetPath?: string): void {
  const gaps = readGaps(dir);
  const stats = conceptStats(gaps);
  const classes = new Map<string, ConceptClass>([...stats].map(([id, s]) => [id, classifyConcept(s)]));
  const targets = activeTargets(gaps);
  const badq = badqData(gaps);
  const now = new Date();
  const cwd = process.cwd();
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim() ?? null;
  const repo = repoNameFor(cwd);
  const headSha = git(cwd, ["rev-parse", "HEAD"])?.trim() ?? "none";

  let file: string;
  let hunk: string;
  let concepts: string[];

  if (!targetPath) {
    const { state } = readState(dir);
    const d = root ? getDiff(cwd, state.last_sha) : null;
    const parsed = d
      ? parseDiff(d.diff)
          .filter((f) => isSourcePath(f.path))
          .filter((f) => !badqSuppressed(badq.files, f.path, now))
      : [];
    const gated = new Set(
      gaps.filter((g) => g.type === undefined && typeof g.file === "string").map((g) => g.file as string),
    );
    // No threshold here — the user asked to be quizzed; best hunk wins even if small.
    const { top } = scoreDiff(parsed, gated, classes, badq.concepts, targets);
    if (!top) {
      console.log("Nothing to quiz — no diff found. Pass a path: gate.ts --quiz <file-or-dir>");
      return;
    }
    file = top.file;
    hunk = top.text;
    concepts = top.concepts;
  } else {
    const abs = resolve(targetPath);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      console.log(`No such path: ${targetPath}`);
      return;
    }
    let fileAbs = abs;
    if (st.isDirectory()) {
      const candidates = listSourceFiles(abs, root);
      let bestScore = -1;
      let best: string | null = null;
      for (const c of candidates) {
        const s = cheapFileScore(c);
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
      if (!best || bestScore < 0) {
        console.log(`No quizzable source files under ${targetPath}`);
        return;
      }
      fileAbs = best;
    }
    const rel = root ? relative(root, fileAbs) : fileAbs;
    if (!isSourcePath(rel)) {
      console.log(`${targetPath} is not a quizzable source file (config/lockfile/generated files are excluded).`);
      return;
    }
    let fst: ReturnType<typeof statSync>;
    try {
      fst = statSync(fileAbs);
    } catch {
      console.log(`No such path: ${targetPath}`);
      return;
    }
    if (fst.size > QUIZ_MAX_BYTES) {
      console.log(`${rel} is too large to quiz (>512KB).`);
      return;
    }
    let content: string;
    try {
      content = readFileSync(fileAbs, "utf8");
    } catch {
      console.log(`Cannot read ${targetPath}.`);
      return;
    }
    if (content.includes("\0")) {
      console.log(`${rel} looks binary — nothing to quiz.`);
      return;
    }
    if (content.trim() === "") {
      console.log(`${rel} is empty — nothing to quiz.`);
      return;
    }
    const w = riskiestWindow(content.split("\n"), rel, classes, targets, badq.concepts);
    if (!w) {
      console.log("Nothing quizzable in that file.");
      return;
    }
    file = rel;
    hunk = w.text;
    concepts = w.concepts;
  }

  // User-initiated: bypass session/daily/snooze, but set last_gate_ts so an
  // auto-gate doesn't also fire minutes later. Best-effort partial write.
  try {
    const { state } = readState(dir);
    writeStateAtomic(dir, { ...state, last_gate_ts: now.toISOString() });
  } catch {}

  const probe = chooseProbe(stats, now, concepts, targets);
  const difficulty = difficultyFor(concepts, classes, targets, stats);
  console.log(
    buildGatePrompt({
      file,
      hunk,
      shortSha: headSha === "none" ? "none" : headSha.slice(0, 8),
      gapsPath: join(dir, "gaps.jsonl"),
      scriptPath: import.meta.path,
      bunPath: process.execPath,
      concepts,
      probe,
      repo,
      via: "quiz",
      difficulty,
    }),
  );
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const dir = stateDir();

  if (arg === "--status") {
    const { streak, files } = computeStatus(readGaps(dir), new Date());
    console.log(`${streak}-day streak · ${files} files explained`);
    return;
  }
  if (arg === "--progress") {
    const a3 = process.argv[3];
    const a4 = process.argv[4];
    const gaps = readGaps(dir);
    if (a3 === "--repo" && a4) {
      console.log(progressReport(gaps, new Date(), a4));
    } else if (a3) {
      console.log(drillDown(gaps, a3));
    } else {
      console.log(progressReport(gaps, new Date()));
    }
    return;
  }
  if (arg === "--debt") {
    console.log(debtReport(process.cwd(), readGaps(dir), new Date()));
    return;
  }
  if (arg === "--quiz") {
    quiz(dir, process.argv[3]);
    return;
  }
  if (arg === "--target" || arg === "--untarget") {
    const id = process.argv[3];
    const gaps = readGaps(dir);
    const targets = activeTargets(gaps);
    if (!id) {
      console.log(
        targets.size
          ? `Growth targets: ${[...targets].join(", ")}`
          : "No growth targets. Add one: gate.ts --target <concept-id>",
      );
      return;
    }
    if (!CONCEPT_ID_RE.test(id)) {
      console.log(`Invalid concept id "${id}" — use kebab-case, e.g. devops-ci`);
      return;
    }
    if (arg === "--target") {
      if (targets.has(id)) {
        console.log(`${id} is already a growth target.`);
        return;
      }
      appendGapLine(dir, { type: "target", ts: new Date().toISOString(), concept: id, on: true });
      console.log(`Growth target added: ${id}. The gate will steer toward it.`);
    } else {
      if (!targets.has(id)) {
        console.log(`${id} is not a growth target. Current: ${[...targets].join(", ") || "none"}`);
        return;
      }
      appendGapLine(dir, { type: "target", ts: new Date().toISOString(), concept: id, on: false });
      console.log(`Growth target removed: ${id}.`);
    }
    return;
  }
  if (arg === "--config") {
    const key = process.argv[3];
    const val = process.argv[4];
    const cfg = readConfig(dir);
    const keys = Object.keys(DEFAULT_CONFIG) as (keyof GateConfig)[];
    if (!key) {
      for (const k of keys) {
        const def = DEFAULT_CONFIG[k];
        console.log(`${k} = ${cfg[k]}${cfg[k] === def ? " (default)" : ` (default ${def})`}`);
      }
      console.log(`Presets: ${Object.keys(PRESETS).join(", ")} — apply with: --config preset <name>`);
      return;
    }
    if (key === "reset") {
      writeConfig(dir, { ...DEFAULT_CONFIG });
      console.log("Config reset to defaults.");
      return;
    }
    if (key === "preset") {
      const p = PRESETS[val ?? ""];
      if (!p) {
        console.log(`Unknown preset "${val ?? ""}". Presets: ${Object.keys(PRESETS).join(", ")}`);
        return;
      }
      writeConfig(dir, { ...p });
      console.log(
        `Preset "${val}": ${keys.map((k) => `${k}=${p[k]}`).join(" · ")}`,
      );
      return;
    }
    if (!keys.includes(key as keyof GateConfig)) {
      console.log(`Unknown key "${key}". Keys: ${keys.join(", ")}`);
      return;
    }
    const k = key as keyof GateConfig;
    if (val === undefined) {
      console.log(`${k} = ${cfg[k]}`);
      return;
    }
    const n = Number(val);
    if (!Number.isFinite(n)) {
      console.log(`"${val}" is not a number.`);
      return;
    }
    const clamped = clampConfigValue(k, n);
    writeConfig(dir, { ...cfg, [k]: clamped });
    console.log(`${k} = ${clamped}${clamped !== Math.round(n) ? ` (clamped from ${val})` : ""}`);
    return;
  }
  if (arg === "--export-md") {
    const p = process.argv[3] ?? join(dir, "KNOWLEDGE.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, knowledgePage(readGaps(dir), new Date()));
    console.log(`Wrote ${p}`);
    return;
  }
  if (arg === "--statusline") {
    try {
      const cache = join(dir, "statusline-cache.txt");
      try {
        const st = statSync(cache);
        if (Date.now() - st.mtimeMs < 60_000) {
          process.stdout.write(readFileSync(cache, "utf8"));
          return;
        }
      } catch {}
      const seg = statuslineSegment(readGaps(dir), new Date());
      try {
        writeFileSync(cache, seg);
      } catch {}
      process.stdout.write(seg);
    } catch {
      // a broken statusline is unacceptable — emit nothing on any error
    }
    return;
  }
  if (arg === "--bad-q") {
    const gaps = readGaps(dir);
    const last = [...gaps].reverse().find((g) => g.type === undefined && typeof g.file === "string");
    if (!last) {
      console.log("No gate on record to flag.");
      return;
    }
    appendGapLine(dir, {
      type: "badq",
      ts: new Date().toISOString(),
      file: last.file,
      concepts: Array.isArray(last.concepts) ? last.concepts : [],
      note: process.argv.slice(3).join(" "),
    });
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
  const gaps = readGaps(dir);
  const config = readConfig(dir);
  if (governorAllows(state, sessionId, now, quietHours(gaps), config)) return;

  const d = getDiff(cwd, state.last_sha);
  if (!d || d.diff.trim() === "") return;
  const digest = sha256(d.diff);
  if (digest === state.last_gated_digest) return; // same dirty tree across sessions

  const gated = new Set(
    gaps.filter((g) => g.type === undefined && typeof g.file === "string").map((g) => g.file as string),
  );
  const stats = conceptStats(gaps);
  const classes = new Map<string, ConceptClass>([...stats].map(([id, s]) => [id, classifyConcept(s)]));
  const targets = activeTargets(gaps);
  const badq = badqData(gaps);
  const parsed = parseDiff(d.diff)
    .filter((f) => isSourcePath(f.path)) // definitive filter (pathspecs are an optimization)
    .filter((f) => !badqSuppressed(badq.files, f.path, now));
  const { total, top } = scoreDiff(parsed, gated, classes, badq.concepts, targets);
  if (total < config.fire_threshold || !top) return;
  const probe = chooseProbe(stats, now, top.concepts, targets);
  const difficulty = difficultyFor(top.concepts, classes, targets, stats);

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
        repo: repoNameFor(cwd),
        via: "stop",
        difficulty,
      }),
    }),
  );
}

if (import.meta.main) {
  main().catch(() => {}); // the gate never breaks a stop
}
