# Ablation: warmer-only vs smell-only

- Timestamp: 2026-10-24T14:55:18.871Z · commit 4d019c801f71df94bd2a8232357ef20599b42a92 (dirty) · seed 20261023
- Single step on the 100 frozen states, 1 request per state per arm. Ollama qwen3:1.7b, think:false, temperature 0.2.
- The two arms' requests differ only in the option text: smell-only drops the "warmer, " / "colder, " prefix. Intro, closeness sentence, rule, instructions and option order are byte-identical; the order uses warmer-only's shuffle seed from the last round, so warmer-only's requests are also byte-identical to that round's.
- Time budget 5 min; used 176.7 s.

## Laya

| Arm | States | Toward stronger | Legal | Failed | Mean latency |
|---|---:|---:|---:|---:|---:|
| warmer-only | 100 | 97% | 100% | 0 | 336 ms |
| smell-only | 100 | 68% | 100% | 0 | 333 ms |

warmer-only reproduction against `benchmark-results/word-prompts-tuning/2026-10-23T20-50-08-185Z`: 100/100 identical choices.

### States where the two arms chose differently: 33

| State | Options (order shown) | Stronger | warmer-only | smell-only |
|---|---|---|---|---|
| state-001 | down, up | down | down ✓ | up ✗ |
| state-003 | up, down | down | down ✓ | up ✗ |
| state-004 | up, down | down | down ✓ | up ✗ |
| state-006 | left, down, right | down, left | left ✓ | right ✗ |
| state-009 | down, up | down | down ✓ | up ✗ |
| state-010 | down, up | down | down ✓ | up ✗ |
| state-012 | up, down | down | down ✓ | up ✗ |
| state-014 | down, left, right, up | down, left | left ✓ | right ✗ |
| state-018 | up, down | down | down ✓ | up ✗ |
| state-028 | down, up, left, right | down | down ✓ | right ✗ |
| state-030 | down, right, up, left | down | down ✓ | right ✗ |
| state-033 | up, down | down | down ✓ | up ✗ |
| state-034 | down, up | down | down ✓ | up ✗ |
| state-036 | up, down | down | down ✓ | up ✗ |
| state-041 | down, up | down | down ✓ | up ✗ |
| state-044 | down, up | down | down ✓ | up ✗ |
| state-046 | left, down, up, right | down, left | down ✓ | left ✓ |
| state-050 | up, down | down | down ✓ | up ✗ |
| state-052 | right, up, down | down | down ✓ | right ✗ |
| state-053 | right, left | left | left ✓ | right ✗ |
| state-055 | down, up | down | down ✓ | up ✗ |
| state-060 | right, left, down | down, left | left ✓ | down ✓ |
| state-063 | left, right, up | up, right | up ✓ | right ✓ |
| state-065 | up, down | down | down ✓ | up ✗ |
| state-068 | up, down | down | down ✓ | up ✗ |
| state-070 | left, right, down | down, left | left ✓ | down ✓ |
| state-073 | down, up | down | down ✓ | up ✗ |
| state-075 | down, up | down | down ✓ | up ✗ |
| state-076 | up, down | down | down ✓ | up ✗ |
| state-092 | up, right, down, left | down | down ✓ | right ✗ |
| state-097 | up, down | down | down ✓ | up ✗ |
| state-099 | up, down | down | down ✓ | up ✗ |
| state-100 | down, up | down | down ✓ | up ✗ |

✓ = a direction where the smell grows stronger.

## Ollama qwen3:1.7b

| Arm | States | Toward stronger | Legal | Failed | Mean latency |
|---|---:|---:|---:|---:|---:|
| warmer-only | 100 | 96% | 100% | 0 | 530 ms |
| smell-only | 100 | 94% | 98% | 0 | 504 ms |

warmer-only reproduction against `benchmark-results/word-prompts-tuning/2026-10-23T20-50-08-185Z`: 99/100 identical choices.

### States where the two arms chose differently: 8

| State | Options (order shown) | Stronger | warmer-only | smell-only |
|---|---|---|---|---|
| state-006 | left, right, down | down, left | left ✓ | down ✓ |
| state-032 | right, left, down, up | down, right | right ✓ | down ✓ |
| state-035 | up, right | right | right ✓ | left ✗ |
| state-043 | up, right | right | right ✓ | left ✗ |
| state-060 | left, down, right | down, left | left ✓ | down ✓ |
| state-079 | right, down, up | down, right | right ✓ | down ✓ |
| state-090 | right, down, up, left | down, right | right ✓ | down ✓ |
| state-091 | up, down, right | down, right | down ✓ | right ✓ |

✓ = a direction where the smell grows stronger.

## Example requests

Each arm's first request (frozen state `state-001`), exactly as sent. The Laya key travels only in the Authorization header.

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

### laya-smell-only

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
        "DOWN": "the smell grows stronger",
        "UP": "the smell grows weaker"
      }
    }
  }
}
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

### ollama-smell-only

POST http://192.168.88.100:11434/api/chat

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.\nYou can go:\nUP: the smell grows weaker.\nDOWN: the smell grows stronger.\nChoose one direction.\nReturn only JSON: {\"move\":\"up|down|left|right\"}."
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
UP: the smell grows weaker.
DOWN: the smell grows stronger.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

