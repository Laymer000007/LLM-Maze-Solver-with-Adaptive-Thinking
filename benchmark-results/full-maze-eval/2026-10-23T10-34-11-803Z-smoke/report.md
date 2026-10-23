# Full-maze evaluation (smoke)

## Setup

- Timestamp: 2026-10-23T10:34:11.803Z
- Git commit: ba58d208720fd2b2da7d9b016616d296825ad7e7 (working tree dirty)
- Mode: smoke; base seed 20261023; seeds 20261023
- Mazes: 2 maze/orientation entries from 1 files (suite has 128)
- Runs: 16
- Step cap: max(4 * optimalSteps, 200); request timeout 45 s; abort after 3 consecutive failed requests; 10 ms sleep after each request; sequential
- Laya: http://192.168.88.100:8000/v1/systemone · Ollama: qwen3:1.7b at http://192.168.88.100:11434
- A step is one policy decision. Wall choices are never corrected: the attempt is recorded, the mouse stays, the step counts. A failed request (timeout, HTTP, unparseable answer) also counts as a step with the mouse staying put; an unparseable answer is fed to memory as an invalid action like the GUI does.
- Memory sequence follows `ObservableMazeSolver.run()`: perceive → rememberPerception → decide → evaluate(from) → rememberAction → rememberPerception(entered).
- Revisit rate = successful moves landing on an already-visited cell / successful moves. Illegal rate = wall choices / steps. Loop = any cell entered ≥5 times. Scorer agreement = decisions that picked an argmax-score legal move.

| Policy | Payload | Model | think | temp | Option order | Reps |
|---|---|---|---|---|---|---:|
| scorer | none (argmax totalExpectedEiLDelta over legal moves; ties broken by seeded RNG) | — | — | — | n/a | 1 |
| fixed-rd | none | — | — | — | first legal of RIGHT, DOWN, UP, LEFT | 1 |
| random-legal | none | — | — | — | uniform over legal moves, seeded | 1 |
| laya-constrained | benchmark.ts layaBody(B-constrained) | Laya router | — | — | legal moves in up,down,left,right order | 1 |
| laya-constrained-shuffled | benchmark.ts layaBody(B-constrained) with shuffled order | Laya router | — | — | legal moves, seeded shuffle per request (criteria keys and prompt-body list use the same order) | 1 |
| laya-raw | benchmark.ts layaBody(A-raw) | Laya router | — | — | all four directions in up,down,left,right order | 1 |
| ollama-constrained | benchmark.ts constrainedPrompt() | qwen3:1.7b | false | 0.2 | legal moves in up,down,left,right order | 1 |
| ollama-raw | benchmark.ts rawPrompt() | qwen3:1.7b | false | 0.2 | all four directions in up,down,left,right order | 1 |

## Per-policy results

| Policy | Completed (95% CI) | Aborted | Median steps (completed) | Mean efficiency | Illegal % | Revisit % | Reversals/run | Loop runs % | Scorer agreement % | Requests | Failed req. | Mean latency ms | Total time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| scorer | 2/2 (100%, 34%–100%) | 0 | 8 | 1.00 | 0.0% | 0.0% | 0.0 | 0% | 100.0% | 0 | 0 | n/a | 0.0 s |
| fixed-rd | 0/2 (0%, 0%–66%) | 0 | n/a | n/a | 0.0% | 98.5% | 197.0 | 100% | 26.0% | 0 | 0 | n/a | 0.0 s |
| random-legal | 2/2 (100%, 34%–100%) | 0 | 71 | 0.12 | 0.0% | 80.3% | 36.0 | 100% | 57.0% | 0 | 0 | n/a | 0.0 s |
| laya-constrained | 0/2 (0%, 0%–66%) | 0 | n/a | n/a | 0.0% | 98.5% | 197.0 | 100% | 3.8% | 400 | 0 | 359 | 2.5 min |
| laya-constrained-shuffled | 1/2 (50%, 9%–91%) | 0 | 14 | 0.57 | 0.0% | 94.9% | 101.0 | 50% | 50.9% | 214 | 0 | 314 | 1.2 min |
| laya-raw | 0/2 (0%, 0%–66%) | 0 | n/a | n/a | 100.0% | 0.0% | 0.0 | 0% | 0.0% | 400 | 0 | 478 | 3.3 min |
| ollama-constrained | 1/2 (50%, 9%–91%) | 0 | 8 | 1.00 | 0.0% | 95.7% | 99.5 | 50% | 51.9% | 208 | 0 | 493 | 1.7 min |
| ollama-raw | 0/2 (0%, 0%–66%) | 0 | n/a | n/a | 0.0% | 98.8% | 197.5 | 100% | 27.3% | 400 | 0 | 646 | 4.4 min |

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
| ollama-constrained | 0/1 (0%, 0%–79%) | 1/1 (100%, 21%–100%) |
| ollama-raw | 0/1 (0%, 0%–79%) | 0/1 (0%, 0%–79%) |

## Direction distribution (all chosen moves, including wall choices)

| Policy | Up | Down | Left | Right | Decisions | First-listed option chosen |
|---|---:|---:|---:|---:|---:|---:|
| scorer | 25% | 25% | 25% | 25% | 16 | n/a |
| fixed-rd | 50% | 50% | 0% | 1% | 400 | n/a |
| random-legal | 25% | 25% | 25% | 25% | 142 | n/a |
| laya-constrained | 26% | 26% | 25% | 25% | 400 | 50% |
| laya-constrained-shuffled | 47% | 49% | 1% | 3% | 214 | 42% |
| laya-raw | 0% | 0% | 50% | 50% | 400 | 0% |
| ollama-constrained | 50% | 48% | 2% | 0% | 208 | 99% |
| ollama-raw | 51% | 50% | 0% | 0% | 400 | 51% |

First-listed = the first option in the order shown to the model, counted only when ≥2 options were shown.

## laya-constrained vs laya-constrained-shuffled

- Completion: fixed order 0/2 (0%, 0%–66%) vs shuffled 1/2 (50%, 9%–91%). The 95% intervals overlap, so no completion difference is detectable at this sample size.
- First-listed option chosen: fixed 50% vs shuffled 42%. Scorer agreement: 3.8% vs 50.9%. Illegal: 0.0% vs 0.0%.
- If the fixed-order first-listed rate is high but falls under shuffling while agreement holds, Laya follows the scores; if agreement falls with the order, it follows position.

## Shortcuts in `src/gui/solver.ts` (none applied here)

- **CHEESE DIRECT TRAVEL** (`solver.ts:349-360, 394-396`): if the model answers `cheese` and the goal is visible with a clear straight line, the mouse walks the whole `Maze.directPath()` trace to the goal from one decision, including diagonal steps. Not applied here; no policy is offered `cheese`.
- **Adaptive thinking** (`solver.ts:386, 412, 434`; `adaptive-thinking.ts`): an EiL drop of ≥100 in one event (e.g. a wall hit, −110) switches Ollama to `think: true` for the next decisions. It changes the model config, not the position. Not applied; every policy here has a fixed config.
- **Health death** (`solver.ts:283, 418, 436, 456`): the GUI loop stops when health reaches 0 (−10 per wall hit or invalid answer, −5 per 20 moves, −33 at EiL thresholds). Here it is recorded as `healthDepletedAtStep` and the run continues to the step cap.
- **Request errors** (`solver.ts:328-341`): the GUI stops on the first HTTP error or timeout. Here a failed request counts as a step and the run aborts after 3 in a row.
- **Corridor auto-advance**: `isDecisionPoint()` is checked in the move loop (`solver.ts:451`), but `planned` holds a single cell unless cheese travel is active, so it never moves the mouse further. No effect.
- The GUI's Laya prompts (`buildRawLayaPrompt`, `buildConstrainedLayaPrompt`) and `LayaClient` criteria (`"<move> movement"`) differ from the `benchmark.ts` payloads used here.

## Limitations

- Smell is `101 − BFS distance to the goal`, so every policy that sees smell or the score (which includes a ±10 smell term) receives a goal-distance gradient. Beyond 101 cells (parts of the 50×50 maze) smell is 0 and the gradient vanishes.
- Ollama is not seeded (the payload matches `benchmark.ts`, which sends no seed); its repetitions are independent samples at temperature 0.2. Laya repetitions differ only if Laya is non-deterministic, except for the shuffled policy.
- Latency is client-observed HTTP time on a shared CPU-only server, not internal inference time. A warm-up request per model is sent before runs and not recorded.
- Health reaching 0 does not end a run here, unlike the GUI; see `healthDepletedAtStep` in runs.csv.
- The 32 source mazes are small and hand-built; orientations reuse them, so runs on one maze are not independent. Wilson intervals treat runs as independent and are therefore optimistic.

## Full-run estimate (from this smoke run)

Full mode: every suite entry, deterministic baselines once, other policies 3 seeds. Point estimate assumes each policy completes at its smoke rate and efficiency; otherwise it runs to the step cap. Time = requests × (smoke mean latency + 10 ms).

| Policy | Runs | Requests min (optimal) | Requests point est. | Requests max (cap) | Time point est. | Time max |
|---|---:|---:|---:|---:|---:|---:|
| scorer | 128 | 0 | 0 | 0 | <1 s | <1 s |
| fixed-rd | 128 | 0 | 0 | 0 | <1 s | <1 s |
| random-legal | 384 | 0 | 0 | 0 | <1 s | <1 s |
| laya-constrained | 384 | 10560 | 84000 | 84000 | 8.6 h | 8.6 h |
| laya-constrained-shuffled | 384 | 10560 | 51240 | 84000 | 4.6 h | 7.6 h |
| laya-raw | 384 | 10560 | 84000 | 84000 | 11.4 h | 11.4 h |
| ollama-constrained | 384 | 10560 | 47280 | 84000 | 6.6 h | 11.7 h |
| ollama-raw | 384 | 10560 | 84000 | 84000 | 15.3 h | 15.3 h |
| **total (model policies)** | | | **350520** | **420000** | **46.5 h** | **54.6 h** |

