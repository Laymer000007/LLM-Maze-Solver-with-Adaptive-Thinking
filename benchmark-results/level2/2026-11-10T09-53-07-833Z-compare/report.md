# Level 2: cat-danger-range5 vs cat-filter-range5 vs cat-filter

- 2026-11-10T09:53:07.833Z · commit f5df0c5 (uncommitted changes) · seeds 20261109, 20261110 (the same for every variant) · Ollama qwen3:1.7b · think off, temperature 0.2
- Time used: 15.0 min of 15. Not run (budget): 01_7x7_open_pass/cat-filter-range5/seed 20261110 (stopped mid-run), 01_7x7_open_pass/cat-filter/seed 20261110, 02_7x7_open_detour/cat-danger-range5/seed 20261110, 02_7x7_open_detour/cat-filter-range5/seed 20261110, 02_7x7_open_detour/cat-filter/seed 20261110, 03_11x11_open_pass/cat-danger-range5/seed 20261110, 03_11x11_open_pass/cat-filter-range5/seed 20261110, 03_11x11_open_pass/cat-filter/seed 20261110, 04_11x11_open_detour/cat-danger-range5/seed 20261110, 04_11x11_open_detour/cat-filter-range5/seed 20261110, 04_11x11_open_detour/cat-filter/seed 20261110, 05_11x11_corridor_loop/cat-danger-range5/seed 20261110, 05_11x11_corridor_loop/cat-filter-range5/seed 20261110, 05_11x11_corridor_loop/cat-filter/seed 20261110, 06_15x15_open_detour/cat-danger-range5/seed 20261110, 06_15x15_open_detour/cat-filter-range5/seed 20261110, 06_15x15_open_detour/cat-filter/seed 20261110.
- Finished, but left out because not every variant ran that level and seed: 01_7x7_open_pass/cat-danger-range5/seed 20261110 (kept in runs.json).
- A sensed choice is safe when the mouse is not caught and does not end one block from the cat. "Sensed" uses each variant's own sensing range.

| Variant | Completed | Caught | Steps / shortest safe (completed) | Safe when sensed | Invalid | Steps filtered (options removed) | Trapped | Latency mean / p95 |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| cat-danger-range5 | 5/6 | 1 | 9/8, 23/12, 42/12, 86/34, 35/16 | 87/95 (92%) | 0 | — | — | 984 ms / 1620 ms |
| cat-filter-range5 | 1/6 | 0 | 18/12 | 96/105 (91%) | 0 | 14/360 steps (41) | 2 steps | 929 ms / 1295 ms |
| cat-filter | 1/6 | 0 | 28/12 | 57/61 (93%) | 0 | 23/370 steps (55) | 1 steps | 888 ms / 1247 ms |

## Per level

| Level | cat-danger-range5 · seed 20261109 | cat-filter-range5 · seed 20261109 | cat-filter · seed 20261109 | cat-danger-range5 · seed 20261110 | cat-filter-range5 · seed 20261110 | cat-filter · seed 20261110 |
|---|---|---|---|---|---|---|
| 01_7x7_open_pass | caught @9 9/7 | step-cap 60/7 | step-cap 60/7 | not run | not run | not run |
| 02_7x7_open_detour | solved 9/8 | step-cap 60/8 | step-cap 60/8 | not run | not run | not run |
| 03_11x11_open_pass | solved 23/12 | solved 18/12 | solved 28/12 | not run | not run | not run |
| 04_11x11_open_detour | solved 42/12 | step-cap 60/12 | step-cap 60/12 | not run | not run | not run |
| 05_11x11_corridor_loop | solved 86/34 | step-cap 102/34 | step-cap 102/34 | not run | not run | not run |
| 06_15x15_open_detour | solved 35/16 | step-cap 60/16 | step-cap 60/16 | not run | not run | not run |

## Catches

For each catch: whether the cat was sensed, its last moves, the options exactly as shown, and the move chosen.

- **cat-danger-range5**, 01_7x7_open_pass, seed 20261109, turn 9 (the cat landed on the mouse). Sensed: 1 block(s) down; the cat's last moves: up, up, up; told: "You sense the cat one block down of you. Its last three moves were up, up, up." Chose **STAY** from:

    LEFT: danger, next to the cat; colder, the smell grows weaker.
    DOWN: danger, next to the cat; warmer, the smell grows stronger.
    STAY: danger, next to the cat; no change, the smell stays the same.
    DOWN-LEFT: danger, next to the cat; no change, the smell stays the same.


## Notes

Computed from runs.json (seed 20261109, the only seed every variant finished).

- "(uncommitted changes)" in the header is this report's own folder, which exists before the git check runs; the code was commit f5df0c5.
- **The filter worked as a safety net:** neither D variant was caught. The filter removed options on 14 of 360 steps (D5) and 23 of 370 (D3); the mouse was trapped on 2 and 1 steps.
- **The D variants failed by wandering, not by the cat:** 10 of their 12 runs hit the step cap. Most of their steps had no cat sensed (D5 255 of 360, D3 309 of 370), and on those steps the filter cannot act (an option within one block of the cat is always within sensing range). The only prompt difference on such steps is the rule line.
- **Smell-following when the cat was not sensed:**

  | Variant | Steps | Chose colder or much colder | Chose no change or colder although warmer was offered |
  |---|---:|---:|---:|
  | C5 | 109 | 22 (20%) | 50 (46%) |
  | D5 | 255 | 82 (32%) | 134 (53%) |
  | D3 | 309 | 103 (33%) | 159 (51%) |

  The new rule line ("Follow the smell, but prefer moves that take you further from the cat.") seems to weaken smell-following even with no cat in sight, so this run cannot separate the filter's effect from the rule's.
- D5 vs D3 (range) cannot be separated either: both completed 1/6 with 0 catches.
- C5's one catch was trapped: every option, STAY included, was marked danger.
- Seed 20261110 did not fit in the budget; one run (01, C5, solved 10/7) finished and is left out of the tables.
