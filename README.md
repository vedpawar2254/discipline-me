# discipline-me

A Claude Code hook that quizzes you on the code your AI just wrote, because
somewhere around week six you realized you couldn't explain your own repo.

The deal is simple: Claude writes a risky diff, you accept it without reading
it (as is tradition), and right when the turn ends, the gate blocks and asks
you to explain what just happened. You either can, which feels great, or you
can't, which is the entire point.

There's science behind the guilt: an Anthropic RCT (Jan 2026) found
AI-assisted devs score 17% lower on comprehension of their own code. The
protective factor was asking *why* instead of delegating wholesale. This tool
makes the asking non-optional. You're welcome, or possibly I'm sorry.

It is also polite about it, to a degree you control. Out of the box: once per
session, three times a day, 45 minutes apart, never in plan mode, never on
config trivia. Too soft? `gate --config preset strict`. Feeling ambitious?
There's a `drill-sergeant` preset, and it means it. It's a gate, not a
roommate — but the lease terms are yours.

## During a gate — say any of these

| You say | What happens |
|---------|--------------|
| (an actual answer) | Graded 0-2 against the real hunk. The grader must cite one thing you didn't mention, so "great answer!" is banned by law |
| `skip` | Gate ends instantly. Logged, never judged. Out loud, anyway |
| `snooze` | No more gates until midnight. For days when you have feelings |
| `no clue` | Honest zero, then a from-scratch explanation in plain words, capped at 25 lines so it teaches you instead of burying you |
| `bad question` | You just trained the targeting. File's off-limits for 14 days and it stops asking that kind of thing |

## Skills (work anytime, not just in gates)

- **`/quiz [path]`** — quiz me NOW: current diff, a file's riskiest 50-line
  window, or the riskiest file in a directory. Skips the politeness because
  you asked for it. Still logs.
- **`/no-clue <topic>`** — explain from the very start, simple words, grounded
  in the code on screen. 25-line cap, "go deeper" peels the next layer.
  Quietly files the topic under "things we're working on."
- **`/bad-q`** — flag the last question as pointless. It listens.

## The knowledge model

The gate keeps receipts. Everything is event-sourced from one JSONL file —
no database, no service, no account, nobody's roadmap.

- Every gate is tagged with **concepts** from a 17-item vocabulary: async &
  concurrency, error handling, types & generics, regex, processes, filesystem,
  networking, SQL, crypto, testing, data structures, CLI/shell, UI, plus the
  infra crowd — CI/CD workflows, containers, infra-as-code, build tooling.
  Yes, that means editing a GitHub workflow can get you quizzed on what
  `runs-on` does. That's a feature. You clicked merge on it.
- Per concept you're classified **strength** (≥3 attempts, avg ≥1.5),
  **growing** (recent avg up ≥0.5), **struggling** (avg <1, or you rated
  yourself ≤2), or learning.
- **Growth targets** (`--target devops-ci`): tell it what you want to learn
  and it leans in — strongest quiz-steering (+3), beginner-mode questions
  until you've earned harder ones, priority calibration.
- **Auto-difficulty:** struggling or newly-targeted concepts get foundation
  questions (plain terms, definitions first). Proven strengths get mastery
  questions — failure modes, "what breaks if…". The gate scales with you,
  in both directions.
- **Steering precedence:** your bad-q flags −2 beat targets +3 beat
  struggling +2 beat mastered −2. Nothing stacks. Your complaints outrank
  its ambitions.
- **Quiet hours:** skip ≥75% of gates in some hour (min 3 samples) and that
  hour goes quiet automatically. It learns you're useless at 1am without
  being told, much like everyone who knows you.
- **Calibration probes:** occasionally one extra "comfort 1-5?" question.
  Max one per gate, 7-day cooldown per concept, ignorable without penalty.
- Every entry records which **repo** it came from, so you can see exactly
  which project owns your debt.

## CLI

```bash
gate --status              # "N-day streak · M files explained"
gate --progress            # full profile: targets, strengths, struggles, quiet hours, repos
gate --progress regex      # one concept, deep: trend sparkline + every entry
gate --progress --repo X   # profile scoped to one repo
gate --quiz [path]         # on-demand gate: diff / file / directory
gate --debt                # per-directory comprehension coverage (30/90-day decay)
gate --target devops-ci    # declare a growth target (--untarget removes, bare --target lists)
gate --export-md           # KNOWLEDGE.md: strengths with receipts, weekly curve
gate --statusline          # compact segment for the statusline (60s cache)
gate --bad-q               # flag the last gate as a bad question
gate --snooze              # no gates until local midnight
gate --config              # show strictness/frequency knobs
gate --config daily_cap 8  # set one knob (also: min_gap_minutes, per_session, fire_threshold)
gate --config preset strict  # chill · default · strict · drill-sergeant
gate --config reset        # back to defaults
```

The presets, for calibration:

| Preset | Gates/day | Min gap | Per session | Fire threshold |
|--------|-----------|---------|-------------|----------------|
| `chill` | 2 | 90 min | 1 | 8 (only big stuff) |
| `default` | 3 | 45 min | 1 | 5 |
| `strict` | 6 | 20 min | 2 | 4 |
| `drill-sergeant` | 12 | 10 min | 3 | 3 (almost everything) |
| `every-diff` | 100 | 2 min | 100 | 3 (you asked for this) |

`every-diff` exists for people who live in one long session and want the gate
on practically every risky diff. The session cap stops mattering; the only
brakes left are the risk threshold and the same-diff digest check. Saying
"quizme" mid-session quizzes the latest diff on demand, any preset.

Lower `fire_threshold` = smaller diffs qualify. Values are clamped to sane
ranges and a corrupt config falls back to defaults, because a nagging tool
that crashes your editor teaches you nothing except regret.

(`gate` being `alias gate='bun ~/.claude/comprehension-gate/gate.ts'`.
Add it, you'll type these more than you think.)

`--debt` deserves a word: it shows what percentage of each directory you've
actually explained, and explanations go stale — full credit for 30 days,
half to 90, then zero. Understanding has a shelf life. So does milk.

## Statusline

`statusline.sh` shows `🔥3d · ▶ regular expressions` in your Claude Code
footer — streak plus your current focus (first growth target, else your worst
struggle). It shows `🔥0d` when you're starting out, because an invisible
statusline is indistinguishable from a broken one. It also preserves your
caveman badge, located by glob so plugin updates don't break it. Wired via:

```json
"statusLine": { "type": "command", "command": "bash ~/.claude/comprehension-gate/statusline.sh" }
```

## Files

- `gate.ts` — the hook + CLI. One file, Bun, no dependencies. Reads like a
  file that got quizzed on itself, which it has been.
- `gate.test.ts` — 79 tests, 17 groups. The annoyance budget is pinned in
  code: the once-per-session, 3-a-day, 45-minute rules have tests, because a
  nagging tool gets uninstalled and an uninstalled tool teaches nothing.
- `statusline.sh` — statusline wrapper.
- `skills/quiz`, `skills/no-clue`, `skills/bad-q` — Claude Code skills,
  symlinked from `~/.claude/skills/`.
- `state.json` — governor state (gitignored).
- `gaps.jsonl` — one line per gate, skip, self-rating, target, and flag.
  The whole product is this file. Everything else is commentary.

## Install

1. Clone to `~/.claude/comprehension-gate/`
2. Register the Stop hook in `~/.claude/settings.json`:

```json
{ "type": "command", "command": "<absolute bun> <absolute path>/gate.ts" }
```

3. Symlink the skills:

```bash
ln -snf ~/.claude/comprehension-gate/skills/quiz ~/.claude/skills/quiz
ln -snf ~/.claude/comprehension-gate/skills/no-clue ~/.claude/skills/no-clue
ln -snf ~/.claude/comprehension-gate/skills/bad-q ~/.claude/skills/bad-q
```

4. Open a new Claude Code session and go write something risky.

## Kill switch / uninstall

- Emergency off: `export COMPREHENSION_GATE_OFF=1`
- Rest of day off: `gate --snooze`
- Forever off: remove the Stop hook entry from settings. The gate holds no
  grudge. The gap file, however, is forever.

## Design

Full design doc (problem, evidence, three approaches, an eng review, and an
argument about annoyance budgets that shaped the whole architecture) lives at
`~/.gstack/projects/gstack/vedpawar2254-main-design-20260719-165949.md`.

## Week-1 checklist (manual, not unit-testable)

- Retrieval question comes before any explanation.
- Grade cites one thing you missed.
- `skip` / `snooze` / `no clue` / `bad question` honored instantly.
- One line lands in `gaps.jsonl` after each gate.
- If your scores are uniformly 2/2, the in-session grader has gone soft.
  It graded code it wrote itself; the conflict of interest was documented
  from day one. That's what the v2 independent grader is for.
