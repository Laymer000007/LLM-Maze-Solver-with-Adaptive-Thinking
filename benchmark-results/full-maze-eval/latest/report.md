# Full-maze evaluation (smoke)

## Read this first: smell is the goal gradient

**Smell = 101 − BFS distance to the goal** (`Maze.smellAt`, `src/maze/maze.ts`). Every policy that is shown smell, or the scorer score (which includes a ±10 term for whether smell rises), is handed the shortest-path gradient to the goal and only has to follow it. Those results measure gradient following, not navigation. **The `*-nosmell` policies are the real navigation test:** they see walls, visit counts and the start/goal coordinates, and nothing derived from the BFS. (Beyond 101 cells from the goal, parts of the 50×50 maze, smell is 0 and the gradient vanishes for everyone.)

| Policy | Goal information shown |
|---|---|
| scorer | scores (incl. ±10 smell term) |
| fixed-rd | walls only |
| random-legal | walls only |
| laya-constrained | scores (incl. ±10 smell term), visits, smell |
| laya-constrained-shuffled | scores (incl. ±10 smell term), visits, smell |
| laya-raw | smell, walls, visits |
| laya-raw-nosmell | walls, visits, coordinates only |
| ollama-constrained | scores (incl. ±10 smell term), visits, smell |
| ollama-raw | smell, walls, visits |
| ollama-raw-nosmell | walls, visits, coordinates only |

## Setup

- Timestamp: 2026-10-23T15:22:22.744Z
- Git commit: a6474c85b21e77af1be7b7a862bc57bf910600a6 (working tree dirty)
- Mode: smoke; base seed 20261023; seeds per policy as in the table below (smoke 1; scorer, fixed-rd 1; random-legal 3; Laya 1 (determinism check passed); Ollama 1)
- Mazes: 2 maze/orientation entries from 1 files (suite has 128)
- Runs: 20
- Stop rules, in order: goal reached → completed; 3 consecutive failed requests → aborted; no new cell visited in the last max(50, 2 * optimalSteps) steps → stuck; max(4 * optimalSteps, 200) steps → step-cap. The same rules apply to every policy.
- Request timeout 45 s; 10 ms sleep after each request; sequential
- Laya: http://192.168.88.100:8000/v1/systemone · Ollama: qwen3:1.7b at http://192.168.88.100:11434
- A step is one policy decision. Wall choices are never corrected: the attempt is recorded, the mouse stays, the step counts. A failed request (timeout, HTTP, unparseable answer) also counts as a step with the mouse staying put; an unparseable answer is fed to memory as an invalid action like the GUI does.
- Memory sequence follows `ObservableMazeSolver.run()`: perceive → rememberPerception → decide → evaluate(from) → rememberAction → rememberPerception(entered).
- Revisit rate = successful moves landing on an already-visited cell / successful moves. Illegal rate = wall choices / steps. Loop = any cell entered ≥5 times. Scorer agreement = decisions that picked an argmax-score legal move.

| Policy | Payload | Model | think | temp | Option order | Seeds |
|---|---|---|---|---|---|---:|
| scorer | none (argmax totalExpectedEiLDelta over legal moves; ties broken by seeded RNG) | — | — | — | n/a | 1 |
| fixed-rd | none | — | — | — | first legal of RIGHT, DOWN, UP, LEFT | 1 |
| random-legal | none | — | — | — | uniform over legal moves, seeded | 1 |
| laya-constrained | benchmark.ts layaBody(B-constrained) | Laya router | — | — | legal moves in up,down,left,right order | 1 |
| laya-constrained-shuffled | benchmark.ts layaBody(B-constrained) with shuffled order | Laya router | — | — | legal moves, seeded shuffle per request (criteria keys and prompt-body list use the same order) | 1 |
| laya-raw | benchmark.ts layaBody(A-raw) | Laya router | — | — | all four directions in up,down,left,right order | 1 |
| laya-raw-nosmell | layaBody(A-raw) with smell removed from body and criteria | Laya router | — | — | all four directions in up,down,left,right order | 1 |
| ollama-constrained | benchmark.ts constrainedPrompt() | qwen3:1.7b | false | 0.2 | legal moves in up,down,left,right order | 1 |
| ollama-raw | benchmark.ts rawPrompt() | qwen3:1.7b | false | 0.2 | all four directions in up,down,left,right order | 1 |
| ollama-raw-nosmell | rawPrompt() with smell removed | qwen3:1.7b | false | 0.2 | all four directions in up,down,left,right order | 1 |

## Harness validation

- **Payload identity:** the test `Laya payload parity with benchmark.ts` (`src/benchmark/full-maze-eval.test.ts`) asserts that the B-constrained and A-raw Laya bodies built here are byte-identical to a verbatim copy of the `benchmark.ts` builders, for all 100 states in `benchmark-results/frozen-dataset.json`.
- **Frozen-state reproduction:** one laya-constrained request per frozen state (2026-10-23T15:07:43.030Z): 59% optimal vs 59% historically; 100% of choices identical to the historical run; 100% legal; 0 failed requests. Results: `benchmark-results/full-maze-eval/validation/2026-10-23T15-07-43-030Z-frozen-laya-constrained`.
- **Criteria check:** every score-bearing Laya request in this run was checked against the maze (visits counted by the harness, score recomputed from smell, visit and new-sight terms): 372 criteria, 0 mismatches. An offline replay of the first smoke run (commit a6474c8) checked 996 criteria with 0 mismatches.
- **Laya determinism:** laya-constrained run twice on 4 entries (7x7_open_detour@original, 11x11_corridor_loop@mirror-h, 15x15_corridor_spiral@mirror-v, v212_open_goal_8_2@rotate-180): all move sequences identical, so every Laya policy runs with 1 seed. Results: `benchmark-results/full-maze-eval/validation/2026-10-23T15-17-18-270Z-determinism`.

## Per-policy results

| Policy | Completed (95% CI) | Stuck | Step-cap | Aborted | Median steps (completed) | Mean efficiency | Illegal % | Revisit % | Reversals/run | Scorer agreement % | Requests | Failed req. | Mean latency ms | Total time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| scorer | 2/2 (100%, 34%–100%) | 0 | 0 | 0 | 8 | 1.00 | 0.0% | 0.0% | 0.0 | 100.0% | 0 | 0 | n/a | 0.0 s |
| fixed-rd | 0/2 (0%, 0%–66%) | 2 | 0 | 0 | n/a | n/a | 0.0% | 94.3% | 50.0 | 28.3% | 0 | 0 | n/a | 0.0 s |
| random-legal | 2/2 (100%, 34%–100%) | 0 | 0 | 0 | 71 | 0.12 | 0.0% | 80.3% | 36.0 | 57.0% | 0 | 0 | n/a | 0.0 s |
| laya-constrained | 0/2 (0%, 0%–66%) | 2 | 0 | 0 | n/a | n/a | 0.0% | 94.4% | 51.0 | 13.9% | 108 | 0 | 375 | 41.6 s |
| laya-constrained-shuffled | 1/2 (50%, 9%–91%) | 1 | 0 | 0 | 14 | 0.57 | 0.0% | 83.1% | 26.5 | 53.8% | 65 | 0 | 317 | 21.3 s |
| laya-raw | 0/2 (0%, 0%–66%) | 2 | 0 | 0 | n/a | n/a | 100.0% | 0.0% | 0.0 | 0.0% | 100 | 0 | 476 | 48.7 s |
| laya-raw-nosmell | 0/2 (0%, 0%–66%) | 2 | 0 | 0 | n/a | n/a | 96.2% | 0.0% | 0.0 | 3.8% | 104 | 0 | 407 | 43.4 s |
| ollama-constrained | 1/2 (50%, 9%–91%) | 1 | 0 | 0 | 8 | 1.00 | 0.0% | 84.7% | 25.0 | 57.6% | 59 | 0 | 523 | 31.5 s |
| ollama-raw | 0/2 (0%, 0%–66%) | 2 | 0 | 0 | n/a | n/a | 0.0% | 95.2% | 50.0 | 33.3% | 105 | 0 | 654 | 1.2 min |
| ollama-raw-nosmell | 0/2 (0%, 0%–66%) | 2 | 0 | 0 | n/a | n/a | 0.0% | 95.2% | 50.0 | 33.3% | 105 | 0 | 576 | 1.0 min |

## Completion by orientation

Original mazes mostly put the goal down-right of the start; mirror-h moves it down-left, mirror-v up-right, rotate-180 up-left. A direction-biased policy should drop off on the transformed orientations.

| Policy | original | rotate-180 |
|---|---|---|
| scorer | 1/1 (100%, 21%–100%) | 1/1 (100%, 21%–100%) |
| fixed-rd | 0/1 (0%, 0%–79%) | 0/1 (0%, 0%–79%) |
| random-legal | 1/1 (100%, 21%–100%) | 1/1 (100%, 21%–100%) |
| laya-constrained | 0/1 (0%, 0%–79%) | 0/1 (0%, 0%–79%) |
| laya-constrained-shuffled | 1/1 (100%, 21%–100%) | 0/1 (0%, 0%–79%) |
| laya-raw | 0/1 (0%, 0%–79%) | 0/1 (0%, 0%–79%) |
| laya-raw-nosmell | 0/1 (0%, 0%–79%) | 0/1 (0%, 0%–79%) |
| ollama-constrained | 0/1 (0%, 0%–79%) | 1/1 (100%, 21%–100%) |
| ollama-raw | 0/1 (0%, 0%–79%) | 0/1 (0%, 0%–79%) |
| ollama-raw-nosmell | 0/1 (0%, 0%–79%) | 0/1 (0%, 0%–79%) |

## Direction distribution (all chosen moves, including wall choices)

| Policy | Up | Down | Left | Right | Decisions | First-listed option chosen |
|---|---:|---:|---:|---:|---:|---:|
| scorer | 25% | 25% | 25% | 25% | 16 | n/a |
| fixed-rd | 49% | 49% | 0% | 2% | 106 | n/a |
| random-legal | 25% | 25% | 25% | 25% | 142 | n/a |
| laya-constrained | 27% | 26% | 23% | 24% | 108 | 50% |
| laya-constrained-shuffled | 40% | 45% | 5% | 11% | 65 | 50% |
| laya-raw | 0% | 0% | 50% | 50% | 100 | 0% |
| laya-raw-nosmell | 4% | 0% | 0% | 96% | 104 | 4% |
| ollama-constrained | 49% | 44% | 7% | 0% | 59 | 97% |
| ollama-raw | 51% | 49% | 0% | 0% | 105 | 51% |
| ollama-raw-nosmell | 51% | 49% | 0% | 0% | 105 | 51% |

First-listed = the first option in the order shown to the model, counted only when ≥2 options were shown.

## laya-constrained vs laya-constrained-shuffled

- Completion: fixed order 0/2 (0%, 0%–66%) vs shuffled 1/2 (50%, 9%–91%). The 95% intervals overlap, so no completion difference is detectable at this sample size.
- First-listed option chosen: fixed 50% vs shuffled 50%. Scorer agreement: 13.9% vs 53.8%. Illegal: 0.0% vs 0.0%.
- If the fixed-order first-listed rate is high but falls under shuffling while agreement holds, Laya follows the scores; if agreement falls with the order, it follows position.

## Shortcuts in `src/gui/solver.ts` (none applied here)

- **CHEESE DIRECT TRAVEL** (`solver.ts:349-360, 394-396`): if the model answers `cheese` and the goal is visible with a clear straight line, the mouse walks the whole `Maze.directPath()` trace to the goal from one decision, including diagonal steps. Not applied here; no policy is offered `cheese`.
- **Adaptive thinking** (`solver.ts:386, 412, 434`; `adaptive-thinking.ts`): an EiL drop of ≥100 in one event (e.g. a wall hit, −110) switches Ollama to `think: true` for the next decisions. It changes the model config, not the position. Not applied; every policy here has a fixed config.
- **Health death** (`solver.ts:283, 418, 436, 456`): the GUI loop stops when health reaches 0 (−10 per wall hit or invalid answer, −5 per 20 moves, −33 at EiL thresholds). Here it is recorded as `healthDepletedAtStep` and the run continues to the step cap.
- **Request errors** (`solver.ts:328-341`): the GUI stops on the first HTTP error or timeout. Here a failed request counts as a step and the run aborts after 3 in a row.
- **Corridor auto-advance**: `isDecisionPoint()` is checked in the move loop (`solver.ts:451`), but `planned` holds a single cell unless cheese travel is active, so it never moves the mouse further. No effect.
- The GUI's Laya prompts (`buildRawLayaPrompt`, `buildConstrainedLayaPrompt`) and `LayaClient` criteria (`"<move> movement"`) differ from the `benchmark.ts` payloads used here.

## Limitations

- See "Read this first": smell-aware results are gradient following. Only the `*-nosmell` policies and the walls-only baselines are free of the BFS gradient.
- Laya is run with one seed when the determinism check passes; Ollama is not seeded (the payload matches `benchmark.ts`, which sends no seed) and Tier B runs it once per entry, so Ollama results carry sampling noise at temperature 0.2.
- Latency is client-observed HTTP time on a shared CPU-only server, not internal inference time. A warm-up request per model is sent before runs and not recorded.
- Health reaching 0 does not end a run here, unlike the GUI; see `healthDepletedAtStep` in runs.csv.
- The 32 source mazes are small and hand-built; orientations reuse them, so runs on one maze are not independent. Wilson intervals treat runs as independent and are therefore optimistic.

## Tier estimates (from this smoke run)

Point estimate: each smoke run's length relative to its outcome (optimal steps if completed, stuck window if stuck, cap otherwise), averaged per policy and mapped onto every entry; capped at the step cap. Time = requests × (smoke mean latency + 10 ms), sequential. Laya seeds: 1 (determinism check passed). The smoke maze is small, so the point estimate is rough.

### Tier A: 128 entries

| Policy | Seeds | Runs | Requests min (optimal) | Requests point est. | Requests max (cap) | Time point est. | Time max |
|---|---:|---:|---:|---:|---:|---:|---:|
| scorer | 1 | 128 | 0 | 0 | 0 | <1 s | <1 s |
| fixed-rd | 1 | 128 | 0 | 0 | 0 | <1 s | <1 s |
| random-legal | 3 | 384 | 0 | 0 | 0 | <1 s | <1 s |
| laya-constrained | 1 | 128 | 3520 | 9901 | 28000 | 1.1 h | 3.0 h |
| laya-constrained-shuffled | 1 | 128 | 3520 | 7756 | 28000 | 42.2 min | 2.5 h |
| laya-raw | 1 | 128 | 3520 | 9168 | 28000 | 1.2 h | 3.8 h |
| laya-raw-nosmell | 1 | 128 | 3520 | 9535 | 28000 | 1.1 h | 3.2 h |
| **total** | | **1152** | | **36360** | **112000** | **4.1 h** | **12.6 h** |

### Tier B: 32 entries

| Policy | Seeds | Runs | Requests min (optimal) | Requests point est. | Requests max (cap) | Time point est. | Time max |
|---|---:|---:|---:|---:|---:|---:|---:|
| ollama-constrained | 1 | 32 | 1208 | 2032 | 7840 | 18.1 min | 1.2 h |
| ollama-raw | 1 | 32 | 1208 | 2940 | 7840 | 32.5 min | 1.4 h |
| ollama-raw-nosmell | 1 | 32 | 1208 | 2940 | 7840 | 28.7 min | 1.3 h |
| **total** | | **96** | | **7912** | **23520** | **1.3 h** | **3.9 h** |

