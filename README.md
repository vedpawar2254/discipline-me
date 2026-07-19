# Comprehension Gate

Claude Code Stop hook that quizzes you on the riskiest hunk of the diff you just
accepted — an in-loop cure for AI debt. Fires at most once per session, 3×/day,
45 min apart. Say `skip` to dismiss one gate, `snooze` to end gating until local
midnight.

Design doc: `~/.gstack/projects/gstack/vedpawar2254-main-design-20260719-165949.md`

## Files

- `gate.ts` — the hook (single file, Bun). Also a CLI: `--status`, `--snooze`.
- `gate.test.ts` — full suite (`bun test`, 35 tests, 7 groups).
- `state.json` — governor state (gitignored).
- `gaps.jsonl` — one line per gate/skip: the tuning data (gitignored).

## Registered in

`~/.claude/settings.json` → `hooks.Stop`:

```json
{ "type": "command", "command": "/Users/vedpawar2254/.bun/bin/bun /Users/vedpawar2254/.claude/comprehension-gate/gate.ts" }
```

## Kill switch / uninstall

- Emergency off: `export COMPREHENSION_GATE_OFF=1` (gate allows everything).
- Rest of day off: `bun gate.ts --snooze`.
- Uninstall: remove the Stop hook entry from `~/.claude/settings.json`.

## Week-1 checklist (manual, not unit-testable)

- Retrieval question comes before any explanation.
- Grade cites one thing you missed.
- `skip` / `snooze` honored instantly.
- `gaps.jsonl` line appended after each gate.
- If scores are near-uniformly 2/2 → grade inflation, accelerate the v2
  independent grader.
