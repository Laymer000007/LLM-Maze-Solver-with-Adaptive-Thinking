# Word prompts vs numbers: Laya and Ollama

- Timestamp: 2026-10-23T16:17:30.044Z · commit 4cab77d7901bcdd2766d228296683363a49235c1 (dirty) · seed 20261023
- Entries: 7x7_corridor_branch@original (optimal 8), 7x7_corridor_branch@rotate-180 (optimal 8), 7x7_open_detour@original (optimal 8), 7x7_open_detour@rotate-180 (optimal 8)
- Step cap max(3 × optimal, 60); stuck when no new cell for max(50, 2 × optimal) steps; 45 s timeout; abort after 3 failed requests in a row; 10 ms between requests
- Option order shuffled per request with a seeded RNG for every model variant. Ollama qwen3:1.7b, think=false, temperature 0.2. Laya http://192.168.88.100:8000/v1/systemone.
- Time budget 15 min; used 680.6 s. Every planned run finished.
- Smell = 101 − BFS distance to the goal, so "stronger that way" is the shortest-path direction. "Toward stronger smell" = chosen moves whose target cell smells stronger than the current one, walls counted as not toward.

## Run note (added after the run)

A harness bug made this run share the servers with an unintended full-maze-eval smoke run (20 runs, 9.1 min). Importing `full-maze-eval.ts` started its own `main()`; this is now fixed with `src/benchmark/as-library.ts`, and that stray run's output was deleted.

- **Choices:** Laya is deterministic (verified), so its choices are unaffected. Ollama samples at temperature 0.2 either way; server load changes timing, not sampling.
- **Latency:** inflated by the shared load. Standalone smoke latencies were about 320–480 ms for Laya and 520–650 ms for Ollama; here they were 475–566 ms and 582–897 ms. Don't compare latency between variants from this run.
- **Sample size:** 4 runs per policy on two 7×7 mazes, 1 seed. Differences of 1–2 completions are not evidence of a better prompt.

## Results

| Policy | Completed | Steps / optimal (completed) | Stuck | Step-cap | Aborted | Wall choices | Toward stronger smell | Mean latency |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| scorer | 4/4 | 8/8, 8/8, 8/8, 8/8 | 0 | 0 | 0 | 0/32 (0%) | 100% | — |
| random-legal | 1/4 | 52/8 | 0 | 3 | 0 | 0/232 (0%) | 53% | — |
| laya-numbers-baseline | 2/4 | 8/8, 18/8 | 1 | 1 | 0 | 0/145 (0%) | 56% | 566 ms |
| laya-words-lookahead | 2/4 | 18/8, 24/8 | 1 | 1 | 0 | 0/158 (0%) | 56% | 558 ms |
| laya-words-feedback | 0/4 | — | 4 | 0 | 0 | 0/210 (0%) | 51% | 475 ms |
| ollama-numbers-baseline | 1/4 | 8/8 | 3 | 0 | 0 | 48/173 (28%) | 39% | 817 ms |
| ollama-words-lookahead | 2/4 | 12/8, 8/8 | 1 | 1 | 0 | 0/139 (0%) | 58% | 897 ms |
| ollama-words-feedback | 0/4 | — | 3 | 1 | 0 | 51/225 (23%) | 42% | 582 ms |

## Per entry

| Policy | 7x7_corridor_branch@original | 7x7_corridor_branch@rotate-180 | 7x7_open_detour@original | 7x7_open_detour@rotate-180 |
|---|---|---|---|---|
| scorer | completed 8 | completed 8 | completed 8 | completed 8 |
| random-legal | completed 52 | step-cap 60 | step-cap 60 | step-cap 60 |
| laya-numbers-baseline | completed 8 | stuck 59 | completed 18 | step-cap 60 |
| laya-words-lookahead | stuck 56 | completed 18 | step-cap 60 | completed 24 |
| laya-words-feedback | stuck 51 | stuck 55 | stuck 52 | stuck 52 |
| ollama-numbers-baseline | stuck 51 | completed 8 | stuck 57 | stuck 57 |
| ollama-words-lookahead | step-cap 60 | completed 12 | stuck 59 | completed 8 |
| ollama-words-feedback | stuck 51 | stuck 57 | step-cap 60 | stuck 57 |

Criteria check on the numeric Laya baseline: 326 criteria, 0 mismatches.

## Example requests

The second request of each policy's first run (so the feedback variant shows a step result), exactly as sent. The Laya API key travels only in the Authorization header, which is not shown.

### laya-numbers-baseline

POST http://192.168.88.100:8000/v1/systemone

```json
{
  "state": {
    "body": "Choose the best legal movement for a maze mouse.\nCurrent position: (1,2)\nGoal position: (5,5)\nOnly these legal choices are available:\nDOWN: score=12; visits=0; smell=95\nUP: score=-10; visits=1; smell=93\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "DOWN": "down movement; existing expected sensor score 12; visited 0",
        "UP": "up movement; existing expected sensor score -10; visited 1"
      }
    }
  }
}
```

### laya-words-lookahead

POST http://192.168.88.100:8000/v1/systemone

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is noticeable.\nChoose the direction most likely to lead to the cheese."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "UP": "an open passage; the smell grows weaker that way; you've been there before",
        "DOWN": "an open passage; the smell grows stronger that way; you haven't been there"
      }
    }
  }
}
```

### laya-words-feedback

POST http://192.168.88.100:8000/v1/systemone

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThat step took you closer: the smell got stronger.\nThe smell is noticeable.\nChoose the direction most likely to lead to the cheese."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "DOWN": "an open passage; you haven't been there",
        "UP": "an open passage; you've been there before"
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
      "content": "Choose the best legal movement for a maze mouse.\nCurrent position: (1,2)\nGoal position: (5,5)\nOnly these legal choices are available:\nUP: score=-10; visits=1; smell=93\nDOWN: score=12; visits=0; smell=95\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
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
Current position: (1,2)
Goal position: (5,5)
Only these legal choices are available:
UP: score=-10; visits=1; smell=93
DOWN: score=12; visits=0; smell=95
Return only JSON: {"move":"up|down|left|right"}.
```

### ollama-words-lookahead

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is noticeable.\nYou can go:\nUP: an open passage; the smell grows weaker that way; you've been there before.\nDOWN: an open passage; the smell grows stronger that way; you haven't been there.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
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
You can go:
UP: an open passage; the smell grows weaker that way; you've been there before.
DOWN: an open passage; the smell grows stronger that way; you haven't been there.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

### ollama-words-feedback

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a dark maze, searching for cheese by smell.\nThat step took you closer: the smell got stronger.\nThe smell is noticeable.\nYou can go:\nDOWN: an open passage; you haven't been there.\nUP: an open passage; you've been there before.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
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
That step took you closer: the smell got stronger.
The smell is noticeable.
You can go:
DOWN: an open passage; you haven't been there.
UP: an open passage; you've been there before.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

