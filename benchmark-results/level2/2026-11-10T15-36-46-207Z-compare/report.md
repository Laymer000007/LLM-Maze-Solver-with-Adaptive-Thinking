# Level 2: greedy vs planner vs cat-danger-range5 on 07_30x30_loops_a, 08_30x30_loops_b, 09_40x40_loops_a, 10_40x40_loops_b, 11_50x50_loops_a, 12_50x50_loops_b

- 2026-11-10T15:36:46.207Z · commit bec2014 (uncommitted changes) · seeds 20261109 (the same for every variant) · Ollama qwen3:1.7b · think off, temperature 0.2
- Time used: 13.5 min of 15. Everything planned ran.
- A sensed choice is safe when the mouse is not caught and does not end one block from the cat. "Sensed" uses each variant's own sensing range.

| Variant | Completed | Caught | Steps / shortest safe (completed) | Safe when sensed | Invalid | Steps filtered (options removed) | Trapped | Not sensed: colder | Not sensed: not the warmest when warmer offered | Latency mean / p95 |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| greedy | 0/6 | 6 | — | 3/15 (20%) | 0 | — | — | 0/185 (0%) | 0/185 (0%) | — / — |
| planner | 6/6 | 0 | 40/40, 56/56, 93/93, 95/95, 59/59, 67/67 | 16/20 (80%) | 0 | — | — | 26/390 (7%) | 51/390 (13%) | — / — |
| cat-danger-range5 | 0/6 | 2 | — | 425/459 (93%) | 0 | — | — | 71/571 (12%) | 282/571 (49%) | 773 ms / 1152 ms |

## Per level

| Level | greedy · seed 20261109 | planner · seed 20261109 | cat-danger-range5 · seed 20261109 |
|---|---|---|---|
| 07_30x30_loops_a | caught @35 35/40 | solved 40/40 | step-cap 120/40 |
| 08_30x30_loops_b | caught @24 24/56 | solved 56/56 | step-cap 168/56 |
| 09_40x40_loops_a | caught @60 60/93 | solved 93/93 | caught @190 190/93 |
| 10_40x40_loops_b | caught @8 8/95 | solved 95/95 | step-cap 285/95 |
| 11_50x50_loops_a | caught @20 20/59 | solved 59/59 | caught @66 66/59 |
| 12_50x50_loops_b | caught @53 53/67 | solved 67/67 | step-cap 201/67 |

## Catches

For each catch: whether the cat was sensed, its last moves, the options exactly as shown, and the move chosen.

- **greedy**, 07_30x30_loops_a, seed 20261109, turn 35 (moved onto the cat). Sensed: 1 block(s) down; the cat's last moves: right, right, right; told: "You sense the cat one block down of you. Its last three moves were right, right, right." Chose **DOWN** from:


- **greedy**, 08_30x30_loops_b, seed 20261109, turn 24 (moved onto the cat). Sensed: 1 block(s) down; the cat's last moves: up, up, up; told: "You sense the cat one block down of you. Its last three moves were up, up, up." Chose **DOWN** from:


- **greedy**, 09_40x40_loops_a, seed 20261109, turn 60 (moved onto the cat). Sensed: 1 block(s) right; the cat's last moves: right, left, left; told: "You sense the cat one block right of you. Its last three moves were right, left, left." Chose **RIGHT** from:


- **cat-danger-range5**, 09_40x40_loops_a, seed 20261109, turn 190 (the cat landed on the mouse). Sensed: 1 block(s) right; the cat's last moves: left, left, left; told: "You sense the cat one block right of you. Its last three moves were left, left, left." Chose **STAY** from:

    STAY: danger, next to the cat; no change, the smell stays the same.
    DOWN: further from the cat; colder, the smell grows weaker.
    RIGHT: danger, next to the cat; warmer, the smell grows stronger.
    UP: further from the cat; colder, the smell grows weaker.

- **greedy**, 10_40x40_loops_b, seed 20261109, turn 8 (moved onto the cat). Sensed: 1 block(s) up; the cat's last moves: up, up, down; told: "You sense the cat one block up of you. Its last three moves were up, up, down." Chose **UP** from:


- **greedy**, 11_50x50_loops_a, seed 20261109, turn 20 (moved onto the cat). Sensed: 1 block(s) down-right; the cat's last moves: up, up, up; told: "You sense the cat one block down-right of you. Its last three moves were up, up, up." Chose **DOWN-RIGHT** from:


- **cat-danger-range5**, 11_50x50_loops_a, seed 20261109, turn 66 (the cat landed on the mouse). Sensed: 1 block(s) down-right; the cat's last moves: down, down, up; told: "You sense the cat one block down-right of you. Its last three moves were down, down, up." Chose **RIGHT** from:

    STAY: danger, next to the cat; no change, the smell stays the same.
    UP-RIGHT: further from the cat; no change, the smell stays the same.
    DOWN-RIGHT: danger, next to the cat; no change, the smell stays the same.
    RIGHT: danger, next to the cat; warmer, the smell grows stronger.
    UP: further from the cat; colder, the smell grows weaker.
    DOWN: danger, next to the cat; colder, the smell grows weaker.

- **greedy**, 12_50x50_loops_b, seed 20261109, turn 53 (moved onto the cat). Sensed: 1 block(s) down; the cat's last moves: up, up, up; told: "You sense the cat one block down of you. Its last three moves were up, up, up." Chose **DOWN** from:



## Notes

- "(uncommitted changes)" and commit bec2014 in the header: the commit is read when the report is written. The run started at commit 0ce534a, and later commits during the run (install changes, README) do not touch the evaluation code.
- Greedy and the planner ran in the same order but cost no time. "Safe when sensed" for them uses the default three-block range.
- C5 per run (steps, STAY answers, steps with the cat sensed, the strongest closeness sentence it reached): 07 step cap 120, 19 stays, 67 sensed, "overwhelming" (within two steps of the cheese); 08 step cap 168, 29, 69, "faint"; 09 caught at 190, 94, 24, "faint"; 10 step cap 285, 19, 216, "faint"; 11 caught at 66, 19, 26, "faint"; 12 step cap 201, 37, 57, "noticeable".
