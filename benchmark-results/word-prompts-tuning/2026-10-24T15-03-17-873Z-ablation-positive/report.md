# Ablation: positive-only rule

- Timestamp: 2026-10-24T15:03:17.873Z · commit fd61ce691a68a35e8fc37bcf6296543133e5e3b1 (dirty) · seed 20261023
- Single step on the 100 frozen states, 1 request per state per arm, option order from warmer-only's shuffle seed (identical across all six arms). Ollama qwen3:1.7b, think:false, temperature 0.2.
- Full rule: "The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker."
- Positive rule: "The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger." (replaces the full rule in the body and, for Laya, in the question instructions; nothing else changes).
- The four earlier arms come from `benchmark-results/word-prompts-tuning/2026-10-24T14-55-18-871Z-ablation`; the two positive arms are new. Time budget 5 min; used 157.9 s.

## Laya

| Option text | Rule | Run | Toward stronger | Legal | Failed | Mean latency |
|---|---|---|---:|---:|---:|---:|
| warmer/colder | full (with "Never…") | previous | 97% | 100% | 0 | 336 ms |
| warmer/colder | positive only | new | 100% | 100% | 0 | 286 ms |
| smell only | full (with "Never…") | previous | 68% | 100% | 0 | 333 ms |
| smell only | positive only | new | 68% | 100% | 0 | 271 ms |

warmer-only → warmer-only-positive: 6 states chose differently (3 became toward stronger, 0 stopped being toward stronger): state-006, state-029, state-046, state-063, state-078, state-098.

smell-only → smell-only-positive: 5 states chose differently (2 became toward stronger, 2 stopped being toward stronger): state-006, state-028, state-046, state-060, state-070.

## Ollama qwen3:1.7b

| Option text | Rule | Run | Toward stronger | Legal | Failed | Mean latency |
|---|---|---|---:|---:|---:|---:|
| warmer/colder | full (with "Never…") | previous | 96% | 100% | 0 | 530 ms |
| warmer/colder | positive only | new | 88% | 100% | 0 | 485 ms |
| smell only | full (with "Never…") | previous | 94% | 98% | 0 | 504 ms |
| smell only | positive only | new | 95% | 100% | 0 | 472 ms |

warmer-only → warmer-only-positive: 11 states chose differently (1 became toward stronger, 9 stopped being toward stronger): state-014, state-016, state-022, state-024, state-025, state-035, state-043, state-049, state-053, state-089, state-091.

smell-only → smell-only-positive: 11 states chose differently (3 became toward stronger, 2 stopped being toward stronger): state-015, state-025, state-035, state-043, state-048, state-052, state-060, state-078, state-079, state-080, state-091.

## Example requests (new arms)

Each new arm's first request (frozen state `state-001`), exactly as sent. The Laya key travels only in the Authorization header.

### laya-warmer-only-positive

POST http://192.168.88.100:8000/v1/systemone

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
        "DOWN": "warmer, the smell grows stronger",
        "UP": "colder, the smell grows weaker"
      }
    }
  }
}
```

### laya-smell-only-positive

POST http://192.168.88.100:8000/v1/systemone

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
        "DOWN": "the smell grows stronger",
        "UP": "the smell grows weaker"
      }
    }
  }
}
```

### ollama-warmer-only-positive

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.\nYou can go:\nUP: colder, the smell grows weaker.\nDOWN: warmer, the smell grows stronger.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
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
The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.
You can go:
UP: colder, the smell grows weaker.
DOWN: warmer, the smell grows stronger.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

### ollama-smell-only-positive

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.\nYou can go:\nUP: the smell grows weaker.\nDOWN: the smell grows stronger.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
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
The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.
You can go:
UP: the smell grows weaker.
DOWN: the smell grows stronger.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

