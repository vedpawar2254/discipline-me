---
name: bad-q
description: Flag the last comprehension-gate question as pointless (config trivia, boilerplate, meaningless). Use when the user says /bad-q, "bad question", or complains a gate quiz was bullshit. Trains the gate's targeting.
---

# /bad-q — train the gate's targeting

The user is saying the last comprehension-gate question was not worth asking.
This is training data, not a complaint to argue with.

## Do exactly this

1. Run via Bash (append the user's reason if they gave one):

```bash
/Users/vedpawar2254/.bun/bin/bun /Users/vedpawar2254/.claude/comprehension-gate/gate.ts --bad-q <their words, if any>
```

2. Print the command's output verbatim (one line). Nothing else — no apology,
   no defense of the question, no follow-up question.

## What it does (if the user asks)

Appends a `badq` line to the gate's log. Effects: the flagged file is excluded
from gating for 14 days, and any concept flagged twice loses its scoring boost.
The gate's targeting literally learns from every flag. `--progress` shows the
current knowledge profile.
