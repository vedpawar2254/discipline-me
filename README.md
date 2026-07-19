# discipline-me — Comprehension Gate

Claude Code Stop hook that quizzes you on the riskiest hunk of the diff you just
accepted — an in-loop cure for AI debt. It also **learns you**: tracks what you
know, what you're pushing against, occasionally calibrates by asking, and steers
future quizzes toward your weak spots.

Fires at most once per session, 3×/day, 45 min apart. Never on config files,
never on trivia.

## During a gate — say any of these

| You say | What happens |
|---------|--------------|
| (answer) | Graded 0-2 against the real hunk, gaps filled, one Socratic question |
| `skip` | Gate ends instantly, logged, no nag |
| `snooze` | No more gates until local midnight |
| `no clue` | Honest 0 logged, then a from-scratch plain-words explanation (≤25 lines) |
| `bad question` | Gate ends; targeting learns — file off-limits 14 days, concept flagged |

## Skills (work anytime, not just in gates)

- **`/quiz [path]`** — quiz me NOW: on the current diff, a file's riskiest
  50-line window, or the riskiest file in a directory. Bypasses the governor
  (your choice), still feeds the knowledge model.
- **`/no-clue <topic>`** — explain from the very start, simple words, grounded in
  the code currently on screen. Hard-capped at 25 lines so it doesn't flood your
  context window; say "go deeper" for the next layer. Logs the topic as a
  struggle area.
- **`/bad-q`** — flag the last gate question as pointless. Trains targeting.

## Knowledge model

Everything is event-sourced from `gaps.jsonl` — no extra state:

- Every gate entry is tagged with **concepts** (17-concept vocabulary: async &
  concurrency, error handling, types & generics, regex, processes, filesystem,
  networking, SQL, crypto, testing, data structures, CLI/shell, UI, **CI/CD
  workflows, containers, infra-as-code, build tooling**), detected
  deterministically from the hunk. Infra files (`.github/workflows/*`,
  `Dockerfile`, `docker-compose*`, `*.tf`, `Makefile`) are quizzable domains,
  not excluded config.
- Per concept you're classified **strength** (≥3 attempts, avg ≥1.5),
  **growing** (recent avg up ≥0.5), **struggling** (avg <1, or you rated
  yourself ≤2), or learning.
- **Growth targets** (`--target devops-ci`): declare what you want to learn.
  Targeted concepts get the strongest quiz-steering (+3), foundation-level
  questions until you've proven them, and priority calibration probes.
- **Auto-difficulty:** struggling/targeted-new concepts get foundation questions
  (plain terms, definitions first); proven strengths get mastery questions
  (failure modes, "what breaks if…"); everything else standard.
- **Scorer feedback loop:** bad-q'd concepts −2 > growth target +3 >
  struggling +2 > all-mastered −2. Boosts never stack.
- **Quiet hours:** hours where you skip ≥75% of gates (min 3 samples) go quiet
  automatically — the governor learns your rhythm. Visible in `--progress`.
- **Calibration probes:** struggling or targeted concepts trigger one extra
  "comfort 1-5?" question — max one per gate, 7-day cooldown, ignorable.
- Every entry records the **repo** it came from — per-repo profiles included.

## CLI

```bash
bun gate.ts --status              # "N-day streak · M files explained"
bun gate.ts --progress            # full profile: targets/strengths/struggles/quiet hours/repos
bun gate.ts --progress regex      # drill into one concept: trend sparkline + every entry
bun gate.ts --progress --repo X   # profile scoped to one repo
bun gate.ts --quiz [path]         # on-demand gate: diff / file / directory
bun gate.ts --debt                # per-directory comprehension coverage of cwd repo (30/90-day decay)
bun gate.ts --target devops-ci    # declare a growth target (--untarget to remove, bare --target lists)
bun gate.ts --export-md           # write KNOWLEDGE.md: strengths with receipts, weekly curve
bun gate.ts --statusline          # compact segment for the Claude Code statusline (60s cache)
bun gate.ts --bad-q               # flag last gate as a bad question
bun gate.ts --snooze              # no gates until local midnight
```

## Statusline

`statusline.sh` wraps the caveman badge (found by glob, survives plugin
updates) and appends `🔥3d · ▶ <focus>` — focus is your first growth target,
else your worst struggling concept. Wired in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "bash ~/.claude/comprehension-gate/statusline.sh" }
```

## Files

- `gate.ts` — the hook + CLI (single file, Bun).
- `gate.test.ts` — full suite (`bun test`, 79 tests, 17 groups).
- `statusline.sh` — statusline wrapper (caveman badge + gate segment).
- `skills/quiz/`, `skills/no-clue/`, `skills/bad-q/` — Claude Code skills
  (symlinked from `~/.claude/skills/`).
- `state.json` — governor state (gitignored).
- `gaps.jsonl` — one line per gate/skip/self-rating/target/flag: the data
  (gitignored).

## Install

1. Clone next to your Claude config: `~/.claude/comprehension-gate/`
2. Register in `~/.claude/settings.json` → `hooks.Stop`:

```json
{ "type": "command", "command": "<absolute bun> <absolute path>/gate.ts" }
```

3. Symlink the skills:

```bash
ln -snf ~/.claude/comprehension-gate/skills/no-clue ~/.claude/skills/no-clue
ln -snf ~/.claude/comprehension-gate/skills/bad-q ~/.claude/skills/bad-q
```

## Kill switch / uninstall

- Emergency off: `export COMPREHENSION_GATE_OFF=1`.
- Rest of day off: `bun gate.ts --snooze`.
- Uninstall: remove the Stop hook entry from `~/.claude/settings.json`.

## Design

Approved design doc lives at
`~/.gstack/projects/gstack/vedpawar2254-main-design-20260719-165949.md`
(office-hours + eng-review pipeline). Evidence base: Anthropic RCT (Jan 2026) —
AI-assisted devs score 17% lower on comprehension; "conceptual inquiry" mode is
protective. This tool forces that mode, in-loop, on your own diffs.

## Week-1 checklist (manual, not unit-testable)

- Retrieval question comes before any explanation.
- Grade cites one thing you missed.
- `skip` / `snooze` / `no clue` / `bad question` honored instantly.
- `gaps.jsonl` line appended after each gate.
- If scores are near-uniformly 2/2 → grade inflation, accelerate the v2
  independent grader.
