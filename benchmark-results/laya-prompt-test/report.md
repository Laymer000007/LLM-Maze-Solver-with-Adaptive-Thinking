# Laya Prompt Accuracy Experiment

- Timestamp: 2026-10-17T10:05:52.535Z
- Dataset: 100 frozen states, seed 20261014
- Laya URL: http://192.168.88.100:8000/v1/systemone
- Model/checkpoint request: english
- Repetitions: 3 per state and format

## Summary

| Format | Accuracy | Avg regret | Median regret | Mean latency | Median latency | P95 latency | Invalid | Consistency |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Numbers only | 29.0% | 23.68 | 20 | 245 ms | 245 ms | 277 ms | 0.0% | 100.0% |
| Words only | 16.0% | 24.92 | 22 | 310 ms | 305 ms | 379 ms | 0.0% | 100.0% |
| Numbers + words | 16.0% | 26.30 | 22 | 369 ms | 357 ms | 462 ms | 0.0% | 100.0% |
| Structured | 16.0% | 26.08 | 22 | 323 ms | 308 ms | 400 ms | 0.0% | 100.0% |

## Ranking and recommendation

1. **Numbers only** — 29.0% accuracy, average regret 23.68.
2. **Words only** — 16.0% accuracy, average regret 24.92.
3. **Structured** — 16.0% accuracy, average regret 26.08.
4. **Numbers + words** — 16.0% accuracy, average regret 26.30.

Recommended format after this run: **Numbers only**. Representative exact prompt:

```text
Position: 1,4
Goal: 9,9

Choices:
UP: -10
DOWN: 10

Instruction: Choose the legal direction with the highest numerical score.
Return only the direction label.
```

## Paired accuracy intervals

Bootstrap 95% intervals use state-level accuracy (the three repetitions are not treated as independent samples). Positive values mean the first format is more accurate.

- numbers - words: 6.0 to 20.0 percentage points
- numbers - numbers-words: 7.0 to 20.0 percentage points
- numbers - structured: 7.0 to 20.0 percentage points
- words - numbers-words: -3.0 to 3.0 percentage points
- words - structured: -3.0 to 3.0 percentage points
- numbers-words - structured: 0.0 to 0.0 percentage points

## Per-state accuracy

| State | Category | Numbers | Words | Numbers + words | Structured |
|---|---|---:|---:|---:|---:|
| state-001 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-002 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-003 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-004 | corridor-or-corner-visited | 100% | 0% | 0% | 0% |
| state-005 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-006 | junction-visited | 0% | 0% | 0% | 0% |
| state-007 | junction-visited | 0% | 0% | 0% | 0% |
| state-008 | junction-visited | 0% | 0% | 0% | 0% |
| state-009 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-010 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-011 | dead-end-visited | 100% | 100% | 100% | 100% |
| state-012 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-013 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-014 | junction-visited | 100% | 0% | 0% | 0% |
| state-015 | junction-visited | 0% | 0% | 0% | 0% |
| state-016 | junction-visited | 0% | 0% | 0% | 0% |
| state-017 | junction-visited | 0% | 0% | 0% | 0% |
| state-018 | corridor-or-corner-visited | 0% | 100% | 0% | 0% |
| state-019 | junction-visited | 0% | 0% | 0% | 0% |
| state-020 | corridor-or-corner-visited | 100% | 0% | 0% | 0% |
| state-021 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-022 | junction-visited | 0% | 0% | 0% | 0% |
| state-023 | dead-end-visited | 100% | 100% | 100% | 100% |
| state-024 | corridor-or-corner-visited | 100% | 0% | 100% | 100% |
| state-025 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-026 | junction-visited | 0% | 0% | 0% | 0% |
| state-027 | junction-visited | 0% | 0% | 0% | 0% |
| state-028 | junction-visited | 100% | 0% | 0% | 0% |
| state-029 | junction-visited | 0% | 0% | 0% | 0% |
| state-030 | junction-visited | 100% | 0% | 0% | 0% |
| state-031 | junction-visited | 100% | 0% | 0% | 0% |
| state-032 | junction-visited | 0% | 0% | 0% | 0% |
| state-033 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-034 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-035 | corridor-or-corner-visited | 100% | 0% | 0% | 0% |
| state-036 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-037 | corridor-or-corner-visited | 100% | 100% | 100% | 100% |
| state-038 | junction-visited | 100% | 0% | 0% | 0% |
| state-039 | junction-visited | 0% | 0% | 0% | 0% |
| state-040 | junction-visited | 0% | 0% | 0% | 0% |
| state-041 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-042 | corridor-or-corner-visited | 100% | 100% | 100% | 100% |
| state-043 | corridor-or-corner-visited | 100% | 0% | 0% | 0% |
| state-044 | corridor-or-corner-visited | 100% | 0% | 0% | 0% |
| state-045 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-046 | junction-visited | 0% | 0% | 0% | 0% |
| state-047 | junction-visited | 0% | 0% | 0% | 0% |
| state-048 | junction-visited | 0% | 0% | 0% | 0% |
| state-049 | junction-visited | 0% | 0% | 0% | 0% |
| state-050 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-051 | junction-visited | 0% | 0% | 0% | 0% |
| state-052 | junction-visited | 0% | 0% | 0% | 0% |
| state-053 | corridor-or-corner-visited | 100% | 100% | 100% | 100% |
| state-054 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-055 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-056 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-057 | corridor-or-corner-visited | 100% | 100% | 100% | 100% |
| state-058 | junction-visited | 100% | 0% | 0% | 0% |
| state-059 | junction-visited | 100% | 100% | 100% | 100% |
| state-060 | junction-visited | 0% | 0% | 0% | 0% |
| state-061 | junction-visited | 0% | 0% | 0% | 0% |
| state-062 | junction-visited | 0% | 0% | 0% | 0% |
| state-063 | junction-visited | 0% | 0% | 0% | 0% |
| state-064 | junction-visited | 0% | 0% | 0% | 0% |
| state-065 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-066 | dead-end-visited | 100% | 100% | 100% | 100% |
| state-067 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-068 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-069 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-070 | junction-visited | 0% | 0% | 0% | 0% |
| state-071 | junction-visited | 0% | 0% | 0% | 0% |
| state-072 | junction-visited | 0% | 0% | 0% | 0% |
| state-073 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-074 | corridor-or-corner-visited | 100% | 100% | 100% | 100% |
| state-075 | corridor-or-corner-visited | 100% | 100% | 100% | 100% |
| state-076 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-077 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-078 | junction-visited | 100% | 0% | 0% | 0% |
| state-079 | junction-visited | 0% | 0% | 0% | 0% |
| state-080 | junction-visited | 0% | 0% | 0% | 0% |
| state-081 | junction-visited | 100% | 100% | 100% | 100% |
| state-082 | corridor-or-corner-visited | 100% | 100% | 100% | 100% |
| state-083 | junction-visited | 0% | 0% | 0% | 0% |
| state-084 | dead-end-visited | 100% | 100% | 100% | 100% |
| state-085 | corridor-or-corner-visited | 100% | 0% | 0% | 0% |
| state-086 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-087 | corridor-or-corner-visited | 100% | 100% | 100% | 100% |
| state-088 | corridor-or-corner-visited | 100% | 100% | 100% | 100% |
| state-089 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-090 | junction-visited | 0% | 0% | 0% | 0% |
| state-091 | junction-visited | 0% | 0% | 0% | 0% |
| state-092 | junction-visited | 0% | 0% | 0% | 0% |
| state-093 | junction-visited | 0% | 0% | 0% | 0% |
| state-094 | junction-visited | 0% | 0% | 0% | 0% |
| state-095 | junction-visited | 0% | 0% | 0% | 0% |
| state-096 | junction-visited | 0% | 0% | 0% | 0% |
| state-097 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-098 | junction-visited | 0% | 0% | 0% | 0% |
| state-099 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |
| state-100 | corridor-or-corner-visited | 0% | 0% | 0% | 0% |

## Error analysis

- **state-018 / Numbers + words** (corridor-or-corner-visited): options up=-138, down=8; optimal=down; selected=up; regret=146; repetition=1.
- **state-018 / Structured** (corridor-or-corner-visited): options up=-138, down=8; optimal=down; selected=up; regret=146; repetition=1.
- **state-018 / Numbers only** (corridor-or-corner-visited): options up=-138, down=8; optimal=down; selected=up; regret=146; repetition=1.
- **state-018 / Numbers + words** (corridor-or-corner-visited): options up=-138, down=8; optimal=down; selected=up; regret=146; repetition=2.
- **state-018 / Numbers only** (corridor-or-corner-visited): options up=-138, down=8; optimal=down; selected=up; regret=146; repetition=2.
- **state-018 / Structured** (corridor-or-corner-visited): options up=-138, down=8; optimal=down; selected=up; regret=146; repetition=2.
- **state-018 / Numbers + words** (corridor-or-corner-visited): options up=-138, down=8; optimal=down; selected=up; regret=146; repetition=3.
- **state-018 / Numbers only** (corridor-or-corner-visited): options up=-138, down=8; optimal=down; selected=up; regret=146; repetition=3.
- **state-018 / Structured** (corridor-or-corner-visited): options up=-138, down=8; optimal=down; selected=up; regret=146; repetition=3.
- **state-022 / Numbers only** (junction-visited): options up=-138, down=-42, right=8; optimal=right; selected=up; regret=146; repetition=1.

## Interpretation

Numbers-only isolates numerical score information; words-only removes numbers and tests semantic descriptions; numbers-plus-words combines both; structured tests a compact fixed schema. Because information content differs, this is a practical prompt-format comparison rather than a pure presentation-only ablation.

No production prompt or solver code was changed by this experiment; the winning prompt was not applied.
