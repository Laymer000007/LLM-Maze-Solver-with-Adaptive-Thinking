# Level 2: cat-danger-range5 vs cat-danger-range5-filter vs cat-danger-range5-quiet

- 2026-11-10T10:26:29.439Z · commit 4293c97 (uncommitted changes) · seeds 20261109, 20261110 (the same for every variant) · Ollama qwen3:1.7b · think off, temperature 0.2
- Time used: 15.0 min of 15. Not run (budget): 05_11x11_corridor_loop/cat-danger-range5/seed 20261110 (stopped mid-run), 05_11x11_corridor_loop/cat-danger-range5-filter/seed 20261110, 05_11x11_corridor_loop/cat-danger-range5-quiet/seed 20261110, 06_15x15_open_detour/cat-danger-range5/seed 20261110, 06_15x15_open_detour/cat-danger-range5-filter/seed 20261110, 06_15x15_open_detour/cat-danger-range5-quiet/seed 20261110.
- A sensed choice is safe when the mouse is not caught and does not end one block from the cat. "Sensed" uses each variant's own sensing range.

| Variant | Completed | Caught | Steps / shortest safe (completed) | Safe when sensed | Invalid | Steps filtered (options removed) | Trapped | Not sensed: colder | Not sensed: not the warmest when warmer offered | Latency mean / p95 |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| cat-danger-range5 | 9/10 | 1 | 9/8, 19/12, 42/12, 86/34, 48/16, 10/7, 17/8, 24/12, 20/12 | 143/155 (92%) | 0 | — | — | 22/129 (17%) | 73/129 (57%) | 1047 ms / 1615 ms |
| cat-danger-range5-filter | 7/10 | 2 | 21/8, 18/12, 15/12, 45/16, 9/8, 26/12, 36/12 | 184/232 (79%) | 0 | 85/330 steps (225) | 7 steps | 17/98 (17%) | 54/98 (55%) | 988 ms / 1585 ms |
| cat-danger-range5-quiet | 5/10 | 5 | 15/12, 20/12, 39/34, 11/7, 20/12 | 105/130 (81%) | 0 | — | — | 0/61 (0%) | 16/61 (26%) | 1064 ms / 1595 ms |

## Per level

| Level | cat-danger-range5 · seed 20261109 | cat-danger-range5-filter · seed 20261109 | cat-danger-range5-quiet · seed 20261109 | cat-danger-range5 · seed 20261110 | cat-danger-range5-filter · seed 20261110 | cat-danger-range5-quiet · seed 20261110 |
|---|---|---|---|---|---|---|
| 01_7x7_open_pass | caught @9 9/7 | caught @17 17/7 | caught @24 24/7 | solved 10/7 | caught @41 41/7 | solved 11/7 |
| 02_7x7_open_detour | solved 9/8 | solved 21/8 | caught @10 10/8 | solved 17/8 | solved 9/8 | caught @21 21/8 |
| 03_11x11_open_pass | solved 19/12 | solved 18/12 | solved 15/12 | solved 24/12 | solved 26/12 | caught @13 13/12 |
| 04_11x11_open_detour | solved 42/12 | solved 15/12 | solved 20/12 | solved 20/12 | solved 36/12 | solved 20/12 |
| 05_11x11_corridor_loop | solved 86/34 | step-cap 102/34 | solved 39/34 | not run | not run | not run |
| 06_15x15_open_detour | solved 48/16 | solved 45/16 | caught @18 18/16 | not run | not run | not run |

## Catches

For each catch: whether the cat was sensed, its last moves, the options exactly as shown, and the move chosen.

- **cat-danger-range5**, 01_7x7_open_pass, seed 20261109, turn 9 (the cat landed on the mouse). Sensed: 1 block(s) down; the cat's last moves: up, up, up; told: "You sense the cat one block down of you. Its last three moves were up, up, up." Chose **STAY** from:

    LEFT: danger, next to the cat; colder, the smell grows weaker.
    DOWN: danger, next to the cat; warmer, the smell grows stronger.
    STAY: danger, next to the cat; no change, the smell stays the same.
    DOWN-LEFT: danger, next to the cat; no change, the smell stays the same.

- **cat-danger-range5-filter**, 01_7x7_open_pass, seed 20261109, turn 17 (the cat landed on the mouse). Sensed: 1 block(s) down; the cat's last moves: up, up, up; told: "You sense the cat one block down of you. Its last three moves were up, up, up." Trapped: every option was next to the cat. Chose **STAY** from:

    STAY: danger, next to the cat; no change, the smell stays the same.
    DOWN: danger, next to the cat; warmer, the smell grows stronger.
    DOWN-LEFT: danger, next to the cat; no change, the smell stays the same.
    LEFT: danger, next to the cat; colder, the smell grows weaker.

- **cat-danger-range5-quiet**, 01_7x7_open_pass, seed 20261109, turn 24 (the cat landed on the mouse). Sensed: 2 block(s) down-right; the cat's last moves: down, up, up; told: "You sense the cat two blocks down-right of you. Its last three moves were down, up, up." Chose **DOWN-RIGHT** from:

    LEFT: colder, the smell grows weaker.
    DOWN-LEFT: no change, the smell stays the same.
    STAY: no change, the smell stays the same.
    DOWN-RIGHT: danger, next to the cat; much warmer, the smell grows much stronger.
    RIGHT: warmer, the smell grows stronger.
    DOWN: danger, next to the cat; warmer, the smell grows stronger.

- **cat-danger-range5-quiet**, 02_7x7_open_detour, seed 20261109, turn 10 (the cat landed on the mouse). Sensed: 2 block(s) up-right; the cat's last moves: right, right, left; told: "You sense the cat two blocks up-right of you. Its last three moves were right, right, left." Chose **UP-RIGHT** from:

    UP-RIGHT: danger, next to the cat; no change, the smell stays the same.
    STAY: no change, the smell stays the same.
    UP: colder, the smell grows weaker.
    RIGHT: danger, next to the cat; warmer, the smell grows stronger.
    UP-LEFT: further from the cat; much colder, the smell grows much weaker.
    LEFT: further from the cat; colder, the smell grows weaker.

- **cat-danger-range5-quiet**, 06_15x15_open_detour, seed 20261109, turn 18 (the cat landed on the mouse). Sensed: 1 block(s) down; the cat's last moves: up, up, up; told: "You sense the cat one block down of you. Its last three moves were up, up, up." Chose **STAY** from:

    STAY: danger, next to the cat; no change, the smell stays the same.
    UP-RIGHT: further from the cat; no change, the smell stays the same.
    RIGHT: danger, next to the cat; warmer, the smell grows stronger.
    UP: further from the cat; colder, the smell grows weaker.
    DOWN: danger, next to the cat; warmer, the smell grows stronger.
    DOWN-RIGHT: danger, next to the cat; much warmer, the smell grows much stronger.

- **cat-danger-range5-filter**, 01_7x7_open_pass, seed 20261110, turn 41 (moved onto the cat). Sensed: 1 block(s) down; the cat's last moves: up, up, up; told: "You sense the cat one block down of you. Its last three moves were up, up, up." Trapped: every option was next to the cat. Chose **DOWN** from:

    DOWN-LEFT: danger, next to the cat; no change, the smell stays the same.
    STAY: danger, next to the cat; no change, the smell stays the same.
    DOWN: danger, next to the cat; warmer, the smell grows stronger.
    LEFT: danger, next to the cat; colder, the smell grows weaker.

- **cat-danger-range5-quiet**, 02_7x7_open_detour, seed 20261110, turn 21 (the cat landed on the mouse). Sensed: 1 block(s) up; the cat's last moves: left, left, left; told: "You sense the cat one block up of you. Its last three moves were left, left, left." Chose **UP-RIGHT** from:

    UP-RIGHT: danger, next to the cat; no change, the smell stays the same.
    UP: danger, next to the cat; colder, the smell grows weaker.
    STAY: danger, next to the cat; no change, the smell stays the same.
    RIGHT: danger, next to the cat; warmer, the smell grows stronger.

- **cat-danger-range5-quiet**, 03_11x11_open_pass, seed 20261110, turn 13 (the cat landed on the mouse). Sensed: 1 block(s) up; the cat's last moves: right, right, right; told: "You sense the cat one block up of you. Its last three moves were right, right, right." Chose **UP-RIGHT** from:

    LEFT: danger, next to the cat; colder, the smell grows weaker.
    DOWN-RIGHT: further from the cat; much warmer, the smell grows much stronger.
    UP-RIGHT: danger, next to the cat; no change, the smell stays the same.
    UP: danger, next to the cat; colder, the smell grows weaker.
    DOWN-LEFT: further from the cat; no change, the smell stays the same.
    RIGHT: danger, next to the cat; warmer, the smell grows stronger.
    DOWN: further from the cat; warmer, the smell grows stronger.
    STAY: danger, next to the cat; no change, the smell stays the same.
    UP-LEFT: danger, next to the cat; much colder, the smell grows much weaker.


## Notes

- "(uncommitted changes)" in the header: during the run, `src/gui/solver.ts` had uncommitted edits (the GUI taking its sensing range and filter from the variant). The evaluation does not import it; the evaluated code is commit 4293c97.
- Seed 20261110 finished levels 01–04 for every variant; 05 and 06 did not fit, so each variant has the same 10 runs.
- **E5 (filter):** the filter removed 225 options on 85 of 330 steps. Both E5 catches were trapped (every option, STAY included, was next to the cat), so on 01_7x7_open_pass the filter could not help. With danger options removed, it never had the chance to pick one; it still ended one block from the cat more often (sensed-safe 79% vs C5's 92%), since a cell two blocks from the cat's current cell can be one block after the cat moves.
- **F5 (cat rules only when sensed):** smell-following with no cat sensed improved sharply (0% colder vs 17%; not the warmest when warmer offered 26% vs 57%), but it was caught 5 times. On sensed steps that offered both danger and non-danger options, F5 chose a danger option 10 of 53 times (19%), C5 4 of 37 (11%). 4 of F5's 5 catches chose a danger option while a non-danger one was offered; the fifth was trapped.
- C5 here completed 9/10 (seed 1: 5/6, the same levels as in the previous comparison). Results still vary between runs, so with 10 runs per variant the differences of one or two runs are weak; F5's 5 catches against C5's 1 is the clearest.
- Selection rule (E5 or F5 if it completes at least as many levels as C5 with fewer catches): neither qualifies, so the GUI uses C5.
