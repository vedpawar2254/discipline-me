#!/bin/bash
# discipline-me statusline wrapper for Claude Code.
# Runs the caveman badge (if the plugin is installed — glob, never hardcode the
# cache hash dir) and appends the comprehension-gate segment (cached, 60s TTL).
input=$(cat)

badge=""
for f in "$HOME"/.claude/plugins/cache/caveman/caveman/*/hooks/caveman-statusline.sh; do
  if [ -f "$f" ]; then
    badge=$(printf '%s' "$input" | bash "$f" 2>/dev/null)
    break
  fi
done

gate=$("$HOME/.bun/bin/bun" "$HOME/.claude/comprehension-gate/gate.ts" --statusline 2>/dev/null)

out="$badge"
if [ -n "$gate" ]; then
  if [ -n "$out" ]; then out="$out $gate"; else out="$gate"; fi
fi
printf '%s' "$out"
