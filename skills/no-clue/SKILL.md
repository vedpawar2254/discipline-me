---
name: no-clue
description: Explain a topic from the very start in simple words, grounded in the code currently being discussed. Use when the user says /no-clue, "no clue", "I don't get this at all", or asks to explain something from scratch. Logs the topic as a struggle area in the comprehension-gate knowledge model.
---

# /no-clue — explain from the start, cheaply

The user is telling you they don't understand a topic AT ALL. Ego-free zone: no
"as you probably know", no assumed vocabulary. And CONTEXT BUDGET IS SACRED —
this explanation must not flood the session.

## Input

`/no-clue <topic>` — explain that topic.
`/no-clue` with no argument — explain the thing most recently under discussion
(the last diff, error, or concept in this conversation).

## Hard rules

1. **Max 25 lines total for the first pass.** No file dumps. No re-reading the
   repo. Use ONLY what is already in this conversation's context. If you need
   code to point at, quote at most 5 lines that are already in context.
2. **Structure (exactly three parts):**
   - **Plain words** (max 3 sentences): what the topic IS, as if to a smart
     person who has never seen it. Zero jargon; gloss any term you must use.
   - **In this case** (max 3 beats): what it is doing in the user's actual
     code/situation right now.
   - **Mental model** (1-2 sentences): one analogy or rule of thumb to keep.
3. End with exactly one line: `Deeper? (say "go deeper" for the next layer)`
   Only expand if they ask — each deeper layer is also max 25 lines.
4. No quiz, no Socratic question, no grading. This is teach-only mode.

## Log the struggle signal (always, via Bash, silently)

Append ONE line to `/Users/vedpawar2254/.claude/comprehension-gate/gaps.jsonl`:

```json
{"type":"self","ts":"<ISO8601 now>","concept":"<concept-id>","comfort":1}
```

Pick `<concept-id>` from this vocabulary if one fits: `async-concurrency`,
`error-handling`, `types-generics`, `data-structures`, `regex`, `filesystem`,
`processes`, `network-http`, `sql-db`, `crypto-hash`, `testing`, `cli-shell`,
`ui-frontend`. If none fits, use a short kebab-case slug of the topic (e.g.
`docker-networking`). This marks the topic as a struggle area so the
comprehension gate steers toward it and tracks growth. Do not mention the
logging to the user unless they ask.
