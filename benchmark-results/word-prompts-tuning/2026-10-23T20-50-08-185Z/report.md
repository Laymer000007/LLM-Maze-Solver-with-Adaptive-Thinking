# Word-prompt tuning: toward stronger smell

- Timestamp: 2026-10-23T20:50:08.185Z · commit e4ce7dcf803b32df92b2382a82dee7ebfb598b8c (dirty) · seed 20261023
- Single step on the 100 states of `benchmark-results/frozen-dataset.json`, 1 request per state. Toward stronger = the chosen direction's neighbour smells stronger than the current cell (any such direction counts). Option order shuffled per request with a seeded RNG. No digits in any request; Ollama qwen3:1.7b, temperature 0.2.
- Smell = 101 − BFS distance to the goal, so "stronger that way" is a shortest-path direction. Every frozen state has at least one: yes.
- Time budget 15 min; used 901.0 s.
- Think arm: 10 probe requests averaged 42515 ms, projecting 3826.3 s for all 100 states; capped at 50 states.
- Time budget reached after 901.0 s; the report covers what finished.

## Run note (added after the run)

- **think:true:** 10 of 15 requests hit the 45 s timeout. The 5 that answered took 17–38 s and all chose a stronger direction; think:false got all 15 of the same states right at about 0.5 s each. Thinking adds nothing here and costs about 80× the time.
- **Budget:** the cap rule only chose between 100 and 50 states. At about 42 s per request, even 50 could not fit, so the think arm used the rest of the budget and the maze phase never started. A better rule would drop the think arm after the probe when even the cap does not fit. That is not changed in this commit, so the code matches this run.
- **Best variant per model:** warmer-only, for both Laya and Ollama (think off).

## Laya

| Variant | think | States | Toward stronger | Legal | Failed | Mean latency |
|---|---|---:|---:|---:|---:|---:|
| lookahead | false | 100 | 77% | 100% | 0 | 256 ms |
| lookahead-rule | false | 100 | 89% | 100% | 0 | 383 ms |
| warmer-only | false | 100 | 97% | 100% | 0 | 333 ms |

## Ollama qwen3:1.7b

| Variant | think | States | Toward stronger | Legal | Failed | Mean latency |
|---|---|---:|---:|---:|---:|---:|
| lookahead | false | 100 | 60% | 98% | 0 | 626 ms |
| lookahead-rule | false | 100 | 81% | 100% | 0 | 656 ms |
| warmer-only | false | 100 | 96% | 100% | 0 | 523 ms |
| warmer-only | true | 15 | 33% | 33% | 10 | 40966 ms |

## Maze entries

Not run: the time budget was used up before this phase.

## Example requests

Each arm's first request (frozen state `state-001`), exactly as sent. The Laya key travels only in the Authorization header.

### laya-lookahead

POST http://192.168.88.100:8000/v1/systemone

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nChoose the direction most likely to lead to the cheese."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "DOWN": "an open passage; the smell grows stronger that way; you've been there before",
        "UP": "an open passage; the smell grows weaker that way; you've been there before"
      }
    }
  }
}
```

### laya-lookahead-rule

POST http://192.168.88.100:8000/v1/systemone

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.\nChoose the direction most likely to lead to the cheese."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker. Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "UP": "an open passage; the smell grows weaker that way; you've been there before",
        "DOWN": "an open passage; the smell grows stronger that way; you've been there before"
      }
    }
  }
}
```

### laya-warmer-only

POST http://192.168.88.100:8000/v1/systemone

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.\nChoose the direction most likely to lead to the cheese."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker. Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "DOWN": "warmer, the smell grows stronger",
        "UP": "colder, the smell grows weaker"
      }
    }
  }
}
```

### ollama-lookahead

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nYou can go:\nUP: an open passage; the smell grows weaker that way; you've been there before.\nDOWN: an open passage; the smell grows stronger that way; you've been there before.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
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
The smell is faint.
You can go:
UP: an open passage; the smell grows weaker that way; you've been there before.
DOWN: an open passage; the smell grows stronger that way; you've been there before.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

### ollama-lookahead-rule

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.\nYou can go:\nUP: an open passage; the smell grows weaker that way; you've been there before.\nDOWN: an open passage; the smell grows stronger that way; you've been there before.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
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
The smell is faint.
The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.
You can go:
UP: an open passage; the smell grows weaker that way; you've been there before.
DOWN: an open passage; the smell grows stronger that way; you've been there before.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

### ollama-warmer-only

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.\nYou can go:\nUP: colder, the smell grows weaker.\nDOWN: warmer, the smell grows stronger.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
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
The smell is faint.
The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.
You can go:
UP: colder, the smell grows weaker.
DOWN: warmer, the smell grows stronger.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

### ollama-warmer-only-think

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.\nYou can go:\nDOWN: warmer, the smell grows stronger.\nUP: colder, the smell grows weaker.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
    }
  ],
  "stream": false,
  "format": "json",
  "think": true,
  "options": {
    "temperature": 0.2
  }
}
```

Prompt text as the model reads it:

```text
You are a mouse in a dark maze, searching for cheese by smell.
The smell is faint.
The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.
You can go:
DOWN: warmer, the smell grows stronger.
UP: colder, the smell grows weaker.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

