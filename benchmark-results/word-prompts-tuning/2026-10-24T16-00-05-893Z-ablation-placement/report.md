# Ablation: where Laya gets the rule

- Timestamp: 2026-10-24T16:00:05.893Z · commit de6aadacf14630575b8a70eae04ed2331c772c80 (dirty) · seed 20261023
- Laya only. Single step on the 100 frozen states, 1 request per state per arm, warmer/colder options, positive-only rule ("The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger."), option order from warmer-only's shuffle seed (identical across arms).
- rule-both is laya-best. rule-instructions-only drops the rule line from state.body; rule-state-only drops the rule from questions.move.instructions, leaving "Choose exactly one movement direction. Return the direction label."
- Input tokens are Laya's response `usage.input_tokens`. Time budget 5 min; used 84.7 s.

| Arm | Rule in | States | Toward stronger | Legal | Failed | Mean latency | Input tokens (mean, min–max) | Choices changed vs rule-both |
|---|---|---:|---:|---:|---:|---:|---|---:|
| rule-both | state.body + instructions | 100 | 100% | 100% | 0 | 302 ms | 123 (106–142) | — |
| rule-instructions-only | instructions only | 100 | 99% | 100% | 0 | 245 ms | 102 (85–121) | 2 |
| rule-state-only | state.body only | 100 | 97% | 100% | 0 | 246 ms | 103 (86–122) | 4 |

rule-both reproduction against `benchmark-results/word-prompts-tuning/2026-10-24T15-03-17-873Z-ablation-positive` (laya-warmer-only-positive): 100/100 identical choices.

### rule-instructions-only: states that chose differently from rule-both (2)

| State | Options (order shown) | Stronger | rule-both | this arm |
|---|---|---|---|---|
| state-046 | left, down, up, right | down, left | left ✓ | down ✓ |
| state-078 | down, right, left, up | down, left | left ✓ | right ✗ |

### rule-state-only: states that chose differently from rule-both (4)

| State | Options (order shown) | Stronger | rule-both | this arm |
|---|---|---|---|---|
| state-006 | left, down, right | down, left | down ✓ | left ✓ |
| state-052 | right, up, down | down | down ✓ | right ✗ |
| state-092 | up, right, down, left | down | down ✓ | right ✗ |
| state-098 | right, down, up | down | down ✓ | right ✗ |

## Example requests

Each arm's first request (frozen state `state-001`), exactly as sent. The key travels only in the Authorization header.

### rule-both

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

### rule-instructions-only

POST http://192.168.88.100:8000/v1/systemone

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nChoose the direction most likely to lead to the cheese."
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

### rule-state-only

POST http://192.168.88.100:8000/v1/systemone

```json
{
  "state": {
    "body": "You are a mouse in a dark maze, searching for cheese by smell.\nThe smell is faint.\nThe cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.\nChoose the direction most likely to lead to the cheese."
  },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "Choose exactly one movement direction. Return the direction label.",
      "criteria": {
        "DOWN": "warmer, the smell grows stronger",
        "UP": "colder, the smell grows weaker"
      }
    }
  }
}
```

