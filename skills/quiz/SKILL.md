---
name: quiz
description: On-demand comprehension quiz on any file, directory, or the current diff. Use when the user says /quiz, "quizme", "quiz me", "quiz me on that diff", "quiz me on the latest diff", "test my understanding", or wants to check they understand code without waiting for the automatic gate. Bare "quizme" means quiz on the latest diff.
---

# /quiz — on-demand comprehension gate

The user is asking to be quizzed right now. This bypasses the gate's governor
(their choice), but still logs results into the knowledge model.

## Do exactly this

1. Run via Bash from the directory the user is working in:

```bash
/Users/vedpawar2254/.bun/bin/bun /Users/vedpawar2254/.claude/comprehension-gate/gate.ts --quiz <path-if-given>
```

- `/quiz`, "quizme", "quiz me on that/the latest diff" → quiz on the current
  diff (omit the path). This is the most common form.
- `/quiz <file>` → quiz on that file's riskiest 50-line window.
- `/quiz <dir>` → quiz on the riskiest file in that directory.

If the no-arg form says "Nothing to quiz" but the user clearly means changes
from this conversation, fall back to `--quiz <file>` with the file you most
recently edited in this session.

2. If the output starts with `COMPREHENSION GATE`, FOLLOW IT EXACTLY — it is
   the gate prompt (retrieval first, grade 0-2 with citation, teach, escape
   hatches, log line, status). All the same rules apply: "skip", "snooze",
   "no clue", "bad question" honored instantly.

3. If the output is a one-line message instead (no diff, path missing, binary,
   etc.), just relay it verbatim.

## Notes (if the user asks)

- Quiz results log with `"via":"quiz"` — they count toward streaks and the
  knowledge profile, but quiz skips never teach the governor quiet hours.
- The window picker steers toward growth targets (`--target`) and struggling
  concepts, same as the automatic gate.
