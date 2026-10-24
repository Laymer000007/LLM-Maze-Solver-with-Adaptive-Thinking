# Maze check: best single-step prompts

- Timestamp: 2026-10-24T15:17:39.284Z · commit 1d399c0b2eea073dbace25f2e5e028f706a719fb (dirty) · seed 20261023
- laya-best: warmer/colder options + positive-only rule ("The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger."). ollama-best: warmer/colder options + full rule ("The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker."), qwen3:1.7b, think:false, temperature 0.2. Numbers baselines: the constrained numeric payloads, shuffled.
- Step cap max(3 × optimal, 60); stuck when no new cell for max(50, 2 × optimal) steps; option order shuffled per request with a seeded RNG. Every policy ran on the first 4 entries before any extra entry. An arm is dropped if it averages over 3000 ms per request after 10 requests; a run is skipped if its step cap at the arm's mean latency would not fit the remaining budget.
- Time budget 15 min; used 855.5 s.
- Skipped 15x15_corridor_spiral@rotate-180/ollama-numbers-baseline: up to 139.8 s needed, 44.5 s left.

## Per policy

| Policy | Entries run | Completed | Steps / optimal (completed) | Stuck | Step-cap | Aborted | Wall choices | Toward stronger smell | Mean latency |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| scorer | 8 | 8/8 | 8/8, 8/8, 8/8, 8/8, 32/32, 32/32, 96/96, 96/96 | 0 | 0 | 0 | 0/288 (0%) | 100% | — |
| random-legal | 8 | 1/8 | 52/8 | 0 | 7 | 0 | 0/1000 (0%) | 52% | — |
| laya-best | 8 | 4/8 | 22/8, 8/8, 8/8, 8/8 | 4 | 0 | 0 | 0/664 (0%) | 60% | 292 ms |
| ollama-best | 8 | 8/8 | 20/8, 10/8, 16/8, 8/8, 36/32, 36/32, 102/96, 98/96 | 0 | 0 | 0 | 0/326 (0%) | 94% | 439 ms |
| laya-numbers-baseline | 8 | 2/8 | 8/8, 18/8 | 4 | 2 | 0 | 0/735 (0%) | 54% | 341 ms |
| ollama-numbers-baseline | 7 | 1/7 | 8/8 | 6 | 0 | 0 | 112/509 (22%) | 41% | 475 ms |

## Per entry

| Policy | 7x7_corridor_branch@original (opt 8) | 7x7_corridor_branch@rotate-180 (opt 8) | 7x7_open_detour@original (opt 8) | 7x7_open_detour@rotate-180 (opt 8) | 11x11_corridor_dead-end@original (opt 32) | 11x11_corridor_dead-end@rotate-180 (opt 32) | 15x15_corridor_spiral@original (opt 96) | 15x15_corridor_spiral@rotate-180 (opt 96) |
|---|---|---|---|---|---|---|---|---|
| scorer | completed 8 | completed 8 | completed 8 | completed 8 | completed 32 | completed 32 | completed 96 | completed 96 |
| random-legal | completed 52 | step-cap 60 | step-cap 60 | step-cap 60 | step-cap 96 | step-cap 96 | step-cap 288 | step-cap 288 |
| laya-best | completed 22 | completed 8 | completed 8 | completed 8 | stuck 80 | stuck 84 | stuck 238 | stuck 216 |
| ollama-best | completed 20 | completed 10 | completed 16 | completed 8 | completed 36 | completed 36 | completed 102 | completed 98 |
| laya-numbers-baseline | completed 8 | stuck 59 | completed 18 | step-cap 60 | step-cap 96 | stuck 65 | stuck 234 | stuck 195 |
| ollama-numbers-baseline | stuck 51 | completed 8 | stuck 57 | stuck 57 | stuck 65 | stuck 78 | stuck 193 | not run |

Criteria check on the Laya numbers baseline: 1400 criteria, 0 mismatches.

## Analysis (added after the run, offline replay of runs.json)

**Why there are no all-colder steps.** Smell is 101 − BFS distance to the goal, so every walkable non-goal cell has an open neighbour one step closer. Checked over all 32 mazes: 3,924 cells, 0 without a warmer neighbour. Backing out of a dead end is "warmer" too, because the dead end lies farther from the goal. The table below is empty by construction; the situation cannot occur with this smell.

**Why laya-best loops on the larger mazes.** The word prompt carries no position, so different cells produce byte-identical requests, and Laya is deterministic. The 664 laya-best decisions came from only 57 distinct requests, and none got two different answers. Corridor steps by closeness: "faint" 354/610 warmer; noticeable/strong/overwhelming 23/23. Option order made no difference: warmer listed first 193/329, second 184/304. The errors come from one bias:

| Request (closeness, options in order shown) | Times | Laya chose |
|---|---:|---|
| faint · LEFT: warmer; RIGHT: colder | 146 | left ✓ |
| faint · RIGHT: colder; LEFT: warmer | 135 | left ✓ |
| faint · DOWN: warmer; RIGHT: colder | 121 | **right ✗** |
| faint · RIGHT: colder; DOWN: warmer | 103 | **right ✗** |
| faint · UP: warmer; RIGHT: colder | 15 | **right ✗** |
| faint · RIGHT: colder; UP: warmer | 17 | **right ✗** |
| faint · UP: warmer; DOWN: colder | 17 | up ✓ |
| noticeable · DOWN: warmer; UP: colder; RIGHT: colder | 4 | **right ✗** |

When RIGHT is offered as colder against a vertical warmer option, Laya picks RIGHT. At the next cell the options are "LEFT: warmer; RIGHT: colder", which it answers correctly, so it steps back. Right, left, right, left: 525 immediate reversals in 664 decisions, against 38 in 326 for ollama-best. The 100 frozen states had few such corner states, so the single-step test (100%) missed this.

## Steps where every open direction is "colder"

For example backing out of a dead end: every legal option says the smell grows weaker, so there is no "warmer" option to follow.

| Policy | Such steps | Legal choices | Wall/illegal or failed | Choices |
|---|---:|---:|---:|---|
| scorer | 0 | 0 | 0 | — |
| random-legal | 0 | 0 | 0 | — |
| laya-best | 0 | 0 | 0 | — |
| ollama-best | 0 | 0 | 0 | — |
| laya-numbers-baseline | 0 | 0 | 0 | — |
| ollama-numbers-baseline | 0 | 0 | 0 | — |

## Example requests

Each model policy's first request, exactly as sent. The Laya key travels only in the Authorization header.

### laya-best

POST http://192.168.88.100:8000/v1/systemone

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is noticeable.\nThe cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.\nChoose the direction most likely to lead to the cheese."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger. Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "DOWN": "warmer, the smell grows stronger"
      }
    }
  }
}
```

### ollama-best

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is noticeable.\nThe cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.\nYou can go:\nDOWN: warmer, the smell grows stronger.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
    }
  ],
  "stream": false,
  "format": "json",
  "think": false,
  "options": {
    "temperature": 0.2
  }
}
```

Prompt text as the model reads it:

```text
You are a mouse in a dark maze, searching for cheese by smell.
The smell is noticeable.
The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.
You can go:
DOWN: warmer, the smell grows stronger.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

### laya-numbers-baseline

POST http://192.168.88.100:8000/v1/systemone

```json
{
  "state": {
    "body": "Choose the best legal movement for a maze mouse.\nCurrent position: (1,1)\nGoal position: (5,5)\nOnly these legal choices are available:\nDOWN: score=22; visits=0; smell=94\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "DOWN": "down movement; existing expected sensor score 22; visited 0"
      }
    }
  }
}
```

### ollama-numbers-baseline

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "Choose the best legal movement for a maze mouse.\nCurrent position: (1,1)\nGoal position: (5,5)\nOnly these legal choices are available:\nDOWN: score=22; visits=0; smell=94\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
    }
  ],
  "stream": false,
  "format": "json",
  "think": false,
  "options": {
    "temperature": 0.2
  }
}
```

Prompt text as the model reads it:

```text
Choose the best legal movement for a maze mouse.
Current position: (1,1)
Goal position: (5,5)
Only these legal choices are available:
DOWN: score=22; visits=0; smell=94
Return only JSON: {"move":"up|down|left|right"}.
```

