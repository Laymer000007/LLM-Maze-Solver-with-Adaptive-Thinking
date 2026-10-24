# Laya: exhaustive single-step test of laya-best, and label variants

- Timestamp: 2026-10-24T17:50:37.844Z · commit 577058c33d4dcdc3103a44f3741f582dcd03fe09 (dirty) · seed 20261023 · http://192.168.88.100:8000/v1/systemone
- laya-best: warmer/colder options, positive-only rule in state.body and instructions. Its request depends only on the open directions, which of them are warmer, the closeness phrase and the option order, so 260 situations (15 open sets × every non-empty warmer subset × 4 closeness phrases) cover every request it can send; each is sent in canonical (up, down, left, right) order and, with ≥2 options, one seeded shuffled order. Laya is deterministic, so each is sent once.
- Label schemes: moves (UP/DOWN/LEFT/RIGHT, as laya-best), compass (NORTH/SOUTH/EAST/WEST), neutral (PATH_A, PATH_B, … by position in the shown order, so the label says nothing about direction). Option text, rule and instructions are identical across schemes; answers are mapped back to moves in code.
- Correct = the chosen direction is one of the warmer ones. Weighted = accuracy weighted by how often each situation occurs over the 15696 walkable non-goal cells of the 128-entry suite (canonical and shuffled answers averaged). Every suite situation is in the enumeration.
- Time budget 15 min; used 788.1 s.
- Best non-direction label scheme: compass (500 vs 483 correct of 504).

## Overall

| Labels | Requests | Correct | Legal | Failed | Canonical order | Shuffled order | Weighted by suite occurrence | Mean latency | Mean input tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| moves | 504 | 485/504 (96%) | 100% | 0 | 251/260 (97%) | 234/244 (96%) | 98% | 298 ms | 126 |
| compass | 504 | 500/504 (99%) | 100% | 0 | 260/260 (100%) | 240/244 (98%) | 99% | 324 ms | 130 |
| neutral | 504 | 483/504 (96%) | 100% | 0 | 248/260 (95%) | 235/244 (96%) | 97% | 330 ms | 132 |

## By directions offered

| directions offered | Suite cells | moves | compass | neutral |
|---|---:|---:|---:|---:|
| up | 30 | 4/4 (100%) | 4/4 (100%) | 4/4 (100%) |
| down | 30 | 4/4 (100%) | 4/4 (100%) | 4/4 (100%) |
| up, down | 984 | 24/24 (100%) | 24/24 (100%) | 24/24 (100%) |
| left | 28 | 4/4 (100%) | 4/4 (100%) | 4/4 (100%) |
| up, left | 262 | 24/24 (100%) | 24/24 (100%) | 24/24 (100%) |
| down, left | 262 | 24/24 (100%) | 24/24 (100%) | 24/24 (100%) |
| up, down, left | 962 | 56/56 (100%) | 53/56 (95%) | 56/56 (100%) |
| right | 28 | 4/4 (100%) | 4/4 (100%) | 4/4 (100%) |
| up, right | 262 | 17/24 (71%) | 24/24 (100%) | 24/24 (100%) |
| down, right | 262 | 16/24 (67%) | 24/24 (100%) | 24/24 (100%) |
| up, down, right | 962 | 52/56 (93%) | 56/56 (100%) | 56/56 (100%) |
| left, right | 1632 | 24/24 (100%) | 24/24 (100%) | 24/24 (100%) |
| up, left, right | 1532 | 56/56 (100%) | 56/56 (100%) | 56/56 (100%) |
| down, left, right | 1532 | 56/56 (100%) | 56/56 (100%) | 56/56 (100%) |
| up, down, left, right | 6928 | 120/120 (100%) | 119/120 (99%) | 99/120 (83%) |

## By number of warmer options

| number of warmer options | moves | compass | neutral |
|---|---:|---:|---:|
| 1 of 1 | 16/16 (100%) | 16/16 (100%) | 16/16 (100%) |
| 1 of 2 | 81/96 (84%) | 96/96 (100%) | 96/96 (100%) |
| 1 of 3 | 92/96 (96%) | 93/96 (97%) | 96/96 (100%) |
| 1 of 4 | 32/32 (100%) | 31/32 (97%) | 17/32 (53%) |
| 2 of 2 | 48/48 (100%) | 48/48 (100%) | 48/48 (100%) |
| 2 of 3 | 96/96 (100%) | 96/96 (100%) | 96/96 (100%) |
| 2 of 4 | 48/48 (100%) | 48/48 (100%) | 42/48 (88%) |
| 3 of 3 | 32/32 (100%) | 32/32 (100%) | 32/32 (100%) |
| 3 of 4 | 32/32 (100%) | 32/32 (100%) | 32/32 (100%) |
| 4 of 4 | 8/8 (100%) | 8/8 (100%) | 8/8 (100%) |

## By closeness

| closeness | moves | compass | neutral |
|---|---:|---:|---:|
| the cheese smell is overwhelming, it must be right here | 120/126 (95%) | 126/126 (100%) | 121/126 (96%) |
| the smell is strong | 121/126 (96%) | 125/126 (99%) | 121/126 (96%) |
| the smell is noticeable | 122/126 (97%) | 125/126 (99%) | 120/126 (95%) |
| the smell is faint | 122/126 (97%) | 124/126 (98%) | 121/126 (96%) |

## Wrong laya-best (moves) answers: 19

| Options (order shown, ✓ = warmer) | Closeness | Answer | Suite cells |
|---|---|---|---:|
| up ✓, right | the cheese smell is overwhelming, it must be right here | RIGHT | 7 |
| right, up ✓ | the cheese smell is overwhelming, it must be right here | RIGHT | 7 |
| up ✓, right | the smell is strong | RIGHT | 8 |
| right, up ✓ | the smell is strong | RIGHT | 8 |
| up ✓, right | the smell is noticeable | RIGHT | 19 |
| up ✓, right | the smell is faint | RIGHT | 69 |
| right, up ✓ | the smell is faint | RIGHT | 69 |
| down ✓, right | the cheese smell is overwhelming, it must be right here | RIGHT | 7 |
| right, down ✓ | the cheese smell is overwhelming, it must be right here | RIGHT | 7 |
| down ✓, right | the smell is strong | RIGHT | 8 |
| right, down ✓ | the smell is strong | RIGHT | 8 |
| down ✓, right | the smell is noticeable | RIGHT | 19 |
| right, down ✓ | the smell is noticeable | RIGHT | 19 |
| down ✓, right | the smell is faint | RIGHT | 69 |
| right, down ✓ | the smell is faint | RIGHT | 69 |
| up ✓, down, right | the cheese smell is overwhelming, it must be right here | RIGHT | 18 |
| down, right, up ✓ | the smell is strong | RIGHT | 23 |
| up, right, down ✓ | the cheese smell is overwhelming, it must be right here | RIGHT | 18 |
| down ✓, right, up | the smell is noticeable | RIGHT | 27 |

## Maze check

Same 8 entries, step cap max(3 × optimal, 60), stuck rule max(50, 2 × optimal), shuffle seeds as laya-best in `benchmark-results/word-prompts-tuning/2026-10-24T15-17-39-284Z-maze-check`.

| Policy | Completed | Steps / optimal (completed) | Stuck | Wall choices | Toward stronger smell | Mean latency | 7x7_corridor_branch@original | 7x7_corridor_branch@rotate-180 | 7x7_open_detour@original | 7x7_open_detour@rotate-180 | 11x11_corridor_dead-end@original | 11x11_corridor_dead-end@rotate-180 | 15x15_corridor_spiral@original | 15x15_corridor_spiral@rotate-180 |
|---|---:|---|---:|---:|---:|---:|---|---|---|---|---|---|---|---|
| laya-best-compass | 8/8 | 8/8, 8/8, 8/8, 8/8, 32/32, 32/32, 96/96, 96/96 | 0 | 0/288 | 100% | 303 ms | completed 8 | completed 8 | completed 8 | completed 8 | completed 32 | completed 32 | completed 96 | completed 96 |
| laya-best | 4/8 | 22/8, 8/8, 8/8, 8/8 | 4 | 0/664 | 60% | 293 ms | completed 22 | completed 8 | completed 8 | completed 8 | stuck 80 | stuck 84 | stuck 238 | stuck 216 |

laya-best reproduction: 8/8 runs move-for-move identical to the earlier maze check.

## Example requests

One situation (options right, up, down; warmer: down; the smell is faint) in each label scheme, exactly as sent. The key travels only in the Authorization header.

### moves

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.\nChoose the direction most likely to lead to the cheese."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger. Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "RIGHT": "colder, the smell grows weaker",
        "UP": "colder, the smell grows weaker",
        "DOWN": "warmer, the smell grows stronger"
      }
    }
  }
}
```

### compass

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.\nChoose the direction most likely to lead to the cheese."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger. Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "EAST": "colder, the smell grows weaker",
        "NORTH": "colder, the smell grows weaker",
        "SOUTH": "warmer, the smell grows stronger"
      }
    }
  }
}
```

### neutral

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.\nChoose the direction most likely to lead to the cheese."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger. Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "PATH_A": "colder, the smell grows weaker",
        "PATH_B": "colder, the smell grows weaker",
        "PATH_C": "warmer, the smell grows stronger"
      }
    }
  }
}
```

