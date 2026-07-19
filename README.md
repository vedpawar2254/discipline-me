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

- **`/no-clue <topic>`** — explain from the very start, simple words, grounded in
  the code currently on screen. Hard-capped at 25 lines so it doesn't flood your
  context window; say "go deeper" for the next layer. Logs the topic as a
  struggle area.
- **`/bad-q`** — flag the last gate question as pointless. Trains targeting.

## Knowledge model

Everything is event-sourced from `gaps.jsonl` — no extra state:

- Every gate entry is tagged with **concepts** (fixed 13-concept vocabulary:
  async & concurrency, error handling, types & generics, regex, processes,
  filesystem, networking, SQL, crypto, testing, data structures, CLI/shell, UI),
  detected deterministically from the hunk.
- Per concept you're classified **strength** (≥3 attempts, avg ≥1.5),
  **growing** (recent avg up ≥0.5), **struggling** (avg <1, or you rated
  yourself ≤2), or learning.
- **Scorer feedback loop:** hunks touching a struggling concept get +2 (the gate
  steers toward weak spots); hunks where every concept is a strength get −2
  (stops quizzing mastery); bad-q'd concepts get −2 (stops asking that kind of
  question).
- **Calibration probes:** when a concept turns struggling, the gate ends with one
  extra "comfort 1-5?" question — max one per gate, 7-day cooldown per concept,
  ignorable.

## CLI

```bash
bun gate.ts --status    # "N-day streak · M files explained"
bun gate.ts --progress  # strengths / growing / pushing-against / not-yet-seen
bun gate.ts --bad-q     # flag last gate as a bad question
bun gate.ts --snooze    # no gates until local midnight
```

## Files

- `gate.ts` — the hook + CLI (single file, Bun).
- `gate.test.ts` — full suite (`bun test`, 50 tests, 10 groups).
- `skills/no-clue/`, `skills/bad-q/` — Claude Code skills (symlinked from
  `~/.claude/skills/`).
- `state.json` — governor state (gitignored).
- `gaps.jsonl` — one line per gate/skip/self-rating/flag: the data (gitignored).

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
