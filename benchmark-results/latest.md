# Laya vs Ollama Maze Decision Benchmark

- Timestamp: 2026-10-14T12:59:41.775Z
- Mode: full
- Dataset seed: 20261014
- Frozen states: 100
- Ollama: qwen3:1.7b at http://192.168.88.100:11434
- Laya endpoint: http://192.168.88.100:8000/v1/systemone
- Ollama settings: temperature 0.2, think=false

## Results

| Experiment/model | Requests | Valid % | Wall % | Optimal % | Consistency % | Mean ms | Median ms | P95 ms | Mean regret |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A-raw/laya | 100 | 65.0 | 35.0 | 33.0 | n/a | 464.4 | 468 | 499 | 46.56 |
| B-constrained/laya | 100 | 100.0 | 0.0 | 59.0 | n/a | 385.0 | 372 | 473 | 11.08 |
| C-repeated/laya | 60 | 100.0 | 0.0 | 50.0 | 100.0 | 377.2 | 391 | 466 | 10.00 |
| A-raw/ollama | 100 | 100.0 | 0.0 | 17.0 | n/a | 774.2 | 931 | 1042 | 26.06 |
| B-constrained/ollama | 100 | 100.0 | 0.0 | 19.0 | n/a | 577.6 | 645 | 905 | 26.16 |
| C-repeated/ollama | 60 | 100.0 | 0.0 | 23.3 | 95.0 | 293.5 | 242 | 668 | 20.30 |

## Methodology

Scores, legal actions, ties, perception, smell, visits, and memory are derived from the production `Maze` and `AgentMemory` implementations. Raw decisions expose sensor state but not calculated scores; constrained decisions expose only legal actions and their existing scores. Illegal outputs are recorded before evaluation. Laya uses documented `/v1/systemone` choice criteria; Ollama uses `/api/chat` with JSON output. No credentials are written to artifacts.

## Limitations

This is a sequential client-observed benchmark. It measures complete HTTP latency, not internal inference time. The frozen dataset is deterministic but generated from the repository’s static maze layouts using a seeded walk; it is not a claim about all mazes.
