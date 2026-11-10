# Final evaluation: words, 8 directions, mood

- 2026-11-09T13:38:55.669Z · commit 13bdb50 (uncommitted changes) · seed 20261109 · Ollama qwen3:1.7b · think off, temperature 0.2, JSON-schema answer
- Time used: 10.6 min of 15. Everything planned ran.
- **full** is the final prompt; **smell-only** is the same without the mood rule, the mood line and the mood phrases. Options are legal directions only, shuffled with a seeded RNG; both variants see the same order.

## Single step

200 situations sampled with a fixed seed from 14940 distinct ones (open directions × level per direction × closeness × mood word).

| Variant | Warmest offered level | Warmer or better | Legal | First listed chosen | Mean latency | p95 latency | Prompt tokens (mean) | Of which cached (mean) | Failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| full | 163/200 (82%) | 200/200 (100%) | 100% | 86/200 (43%) | 1014 ms | 1327 ms | 207 | 79 | 0 |
| smell-only | 159/200 (80%) | 199/200 (100%) | 100% | 89/200 (45%) | 808 ms | 1021 ms | 163 | 67 | 0 |

Most common wrong answers (chosen level and direction over the warmest offered level):

- **full:** warmer (left) over much warmer ×12; warmer (right) over much warmer ×12; warmer (down) over much warmer ×8; warmer (up) over much warmer ×5
- **smell-only:** warmer (right) over much warmer ×14; warmer (left) over much warmer ×12; warmer (down) over much warmer ×9; warmer (up) over much warmer ×5; no change (up-right) over warmer ×1

## Mazes

Entries: 7x7_corridor_branch@original, 7x7_corridor_branch@rotate-180, 7x7_open_detour@original, 7x7_open_detour@rotate-180, 11x11_corridor_dead-end@original, 11x11_corridor_dead-end@rotate-180, 15x15_corridor_spiral@original, 15x15_corridor_spiral@rotate-180. One seed per entry. Step cap max(3 × optimal, 60) with optimal by BFS under the 8-direction rules; stuck when no new cell for max(50, 2 × optimal) steps.

| Policy | Completed | Steps / optimal (completed runs) | Invalid answers | Final mood (mean) | Mean latency |
|---|---:|---|---:|---:|---:|
| greedy | 8/8 | 8/8, 8/8, 6/6, 6/6, 32/32, 32/32, 96/96, 96/96 | 0 | 745 | — |
| random-legal | 3/8 | 54/8, 16/8, 35/6 | 0 | 608 | — |
| full | 8/8 | 8/8, 8/8, 7/6, 7/6, 32/32, 32/32, 96/96, 96/96 | 0 | 745 | 494 ms |
| smell-only | 8/8 | 8/8, 8/8, 7/6, 6/6, 32/32, 32/32, 96/96, 96/96 | 0 | 745 | 448 ms |

### Per entry

| Entry | Optimal | greedy | random-legal | full | smell-only |
|---|---:|---|---|---|---|
| 7x7_corridor_branch@original | 8 | solved 8 · invalid 0 · mood 580 (normal) | solved 54 · invalid 0 · mood 580 (normal) | solved 8 · invalid 0 · mood 580 (normal) | solved 8 · invalid 0 · mood 580 (normal) |
| 7x7_corridor_branch@rotate-180 | 8 | solved 8 · invalid 0 · mood 580 (normal) | solved 16 · invalid 0 · mood 580 (normal) | solved 8 · invalid 0 · mood 580 (normal) | solved 8 · invalid 0 · mood 580 (normal) |
| 7x7_open_detour@original | 6 | solved 6 · invalid 0 · mood 580 (normal) | step-cap 60 · invalid 0 · mood 480 (normal) | solved 7 · invalid 0 · mood 580 (normal) | solved 7 · invalid 0 · mood 580 (normal) |
| 7x7_open_detour@rotate-180 | 6 | solved 6 · invalid 0 · mood 580 (normal) | solved 35 · invalid 0 · mood 580 (normal) | solved 7 · invalid 0 · mood 580 (normal) | solved 6 · invalid 0 · mood 580 (normal) |
| 11x11_corridor_dead-end@original | 32 | solved 32 · invalid 0 · mood 820 (extremely happy) | step-cap 96 · invalid 0 · mood 640 (happy) | solved 32 · invalid 0 · mood 820 (extremely happy) | solved 32 · invalid 0 · mood 820 (extremely happy) |
| 11x11_corridor_dead-end@rotate-180 | 32 | solved 32 · invalid 0 · mood 820 (extremely happy) | step-cap 96 · invalid 0 · mood 520 (normal) | solved 32 · invalid 0 · mood 820 (extremely happy) | solved 32 · invalid 0 · mood 820 (extremely happy) |
| 15x15_corridor_spiral@original | 96 | solved 96 · invalid 0 · mood 1000 (extremely happy) | step-cap 288 · invalid 0 · mood 580 (normal) | solved 96 · invalid 0 · mood 1000 (extremely happy) | solved 96 · invalid 0 · mood 1000 (extremely happy) |
| 15x15_corridor_spiral@rotate-180 | 96 | solved 96 · invalid 0 · mood 1000 (extremely happy) | step-cap 288 · invalid 0 · mood 900 (extremely happy) | solved 96 · invalid 0 · mood 1000 (extremely happy) | solved 96 · invalid 0 · mood 1000 (extremely happy) |

## Notes (added after the run)

- **Decision:** smell-only does not clearly beat full. Its accuracy is the same within noise (80% vs 82% warmest level; both 100% warmer or better; mazes 8/8 for both, 6 vs 7 steps on one detour entry). It is faster: 808 vs 1014 ms per request in the single-step test (163 vs 207 prompt tokens), and 448 vs 494 ms in the mazes. The GUI uses **full**.
- Every wrong answer chose a plain **warmer** over an offered **much warmer** diagonal. No answer was colder and none was illegal; the JSON schema makes illegal answers impossible.
- Mood does not depend on the path taken: every level changes mood by 10 × the change in distance, so on reaching the cheese the mood is always 500 + 10 × the start distance (unless clamped, or after invalid answers). That is why every solved run of the same maze ends with the same mood. Mood adds a feeling to the prompt, not new information.

## Example prompts

Situation s001, exactly as sent (the full request body, then the prompt text).

### full

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a maze, looking for the cheese.\nThe cheese is where the smell is strongest. Always move where the smell grows stronger, and prefer much warmer over warmer. Never choose a direction where the smell grows weaker.\nWarmer moves lift your mood, colder moves lower it.\n\nRight now:\nThe cheese smell is noticeable.\nYour mood is normal.\n\nYou can go:\nUP: colder, the smell grows weaker, your mood drops.\nLEFT: warmer, the smell grows stronger, your mood rises.\nDOWN-RIGHT: no change, the smell stays the same, your mood stays the same.\nRIGHT: warmer, the smell grows stronger, your mood rises.\nDOWN: colder, the smell grows weaker, your mood drops.\nDOWN-LEFT: no change, the smell stays the same, your mood stays the same.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|left|down-right|right|down|down-left\"}."
    }
  ],
  "stream": false,
  "think": false,
  "format": {
    "type": "object",
    "properties": {
      "move": {
        "type": "string",
        "enum": [
          "up",
          "left",
          "down-right",
          "right",
          "down",
          "down-left"
        ]
      }
    },
    "required": [
      "move"
    ]
  },
  "options": {
    "temperature": 0.2
  }
}
```

```text
You are a mouse in a maze, looking for the cheese.
The cheese is where the smell is strongest. Always move where the smell grows stronger, and prefer much warmer over warmer. Never choose a direction where the smell grows weaker.
Warmer moves lift your mood, colder moves lower it.

Right now:
The cheese smell is noticeable.
Your mood is normal.

You can go:
UP: colder, the smell grows weaker, your mood drops.
LEFT: warmer, the smell grows stronger, your mood rises.
DOWN-RIGHT: no change, the smell stays the same, your mood stays the same.
RIGHT: warmer, the smell grows stronger, your mood rises.
DOWN: colder, the smell grows weaker, your mood drops.
DOWN-LEFT: no change, the smell stays the same, your mood stays the same.
Choose one direction.
Return only JSON: {"move":"up|left|down-right|right|down|down-left"}.
```

### smell-only

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a maze, looking for the cheese.\nThe cheese is where the smell is strongest. Always move where the smell grows stronger, and prefer much warmer over warmer. Never choose a direction where the smell grows weaker.\n\nRight now:\nThe cheese smell is noticeable.\n\nYou can go:\nUP: colder, the smell grows weaker.\nLEFT: warmer, the smell grows stronger.\nDOWN-RIGHT: no change, the smell stays the same.\nRIGHT: warmer, the smell grows stronger.\nDOWN: colder, the smell grows weaker.\nDOWN-LEFT: no change, the smell stays the same.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|left|down-right|right|down|down-left\"}."
    }
  ],
  "stream": false,
  "think": false,
  "format": {
    "type": "object",
    "properties": {
      "move": {
        "type": "string",
        "enum": [
          "up",
          "left",
          "down-right",
          "right",
          "down",
          "down-left"
        ]
      }
    },
    "required": [
      "move"
    ]
  },
  "options": {
    "temperature": 0.2
  }
}
```

```text
You are a mouse in a maze, looking for the cheese.
The cheese is where the smell is strongest. Always move where the smell grows stronger, and prefer much warmer over warmer. Never choose a direction where the smell grows weaker.

Right now:
The cheese smell is noticeable.

You can go:
UP: colder, the smell grows weaker.
LEFT: warmer, the smell grows stronger.
DOWN-RIGHT: no change, the smell stays the same.
RIGHT: warmer, the smell grows stronger.
DOWN: colder, the smell grows weaker.
DOWN-LEFT: no change, the smell stays the same.
Choose one direction.
Return only JSON: {"move":"up|left|down-right|right|down|down-left"}.
```

