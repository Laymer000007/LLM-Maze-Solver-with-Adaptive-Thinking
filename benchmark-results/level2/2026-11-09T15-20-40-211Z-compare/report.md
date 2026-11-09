# Level 2: cat-history vs cat-rule vs cat-danger vs cat-danger-range5

- 2026-11-09T15:20:40.211Z · commit d08af07 (uncommitted changes) · seeds 20261109, 20261110 (the same for every variant) · Ollama qwen3:1.7b · think off, temperature 0.2
- Time used: 15.0 min of 15. Not run (budget): 05_11x11_corridor_loop/cat-history/seed 20261110 (stopped mid-run), 05_11x11_corridor_loop/cat-rule/seed 20261110, 05_11x11_corridor_loop/cat-danger/seed 20261110, 05_11x11_corridor_loop/cat-danger-range5/seed 20261110, 06_15x15_open_detour/cat-history/seed 20261110, 06_15x15_open_detour/cat-rule/seed 20261110, 06_15x15_open_detour/cat-danger/seed 20261110, 06_15x15_open_detour/cat-danger-range5/seed 20261110.
- A sensed choice is safe when the mouse is not caught and does not end one block from the cat. "Sensed" uses each variant's own sensing range.

| Variant | Completed | Caught | Steps / shortest safe (completed) | Safe when sensed | Invalid | Latency mean / p95 |
|---|---:|---:|---|---:|---:|---:|
| cat-history | 6/10 | 4 | 7/7, 16/12, 13/12, 19/16, 7/7, 14/12 | 36/49 (73%) | 0 | 1028 ms / 1455 ms |
| cat-rule | 5/10 | 5 | 35/8, 20/12, 7/7, 18/12, 26/12 | 39/65 (60%) | 0 | 926 ms / 1404 ms |
| cat-danger | 5/10 | 5 | 17/8, 39/12, 49/34, 28/7, 30/12 | 70/104 (67%) | 0 | 1024 ms / 1597 ms |
| cat-danger-range5 | 7/10 | 2 | 9/8, 23/12, 45/12, 48/16, 10/7, 17/8, 34/12 | 181/202 (90%) | 0 | 1076 ms / 1688 ms |

## Notes (added after the run)

- **Budget:** the run hit 15 minutes during seed 20261110. Levels 05 and 06 on that seed were not run for any variant, so each variant has 10 runs (cat-history's level-05 run was stopped mid-run and is not counted).
- **Danger labels are followed only partly.** Counted over sensed steps where at least one option said "danger" and at least one did not: cat-danger chose a danger option 14 times out of 65 (22%), cat-danger-range5 12 out of 45 (27%). In 3 steps every option, STAY included, was marked danger.
- **Of the 7 catches with danger labels,** 5 chose a danger option although another was offered: cat-danger on 01/s1, 03/s1, 06/s1 and 03/s2, and cat-danger-range5 on 03/s2. The other 2 were steps where every option said danger. Three of the catches were STAY marked "danger, next to the cat".
- **"Danger" is measured from the cat's current cell, not where it moves next.** Several catches happened one turn after an option that looked safe.
- **cat-rule and cat-history catches** are all the same pattern as before: a "warmer" option straight toward a sensed cat.
- **"Safe when sensed" isn't comparable across sensing ranges.** cat-danger-range5 senses from five blocks, so many of its sensed steps are far from the cat.
- **The danger variants take longer paths:** for example 45/12 and 48/16 steps, against 13/12 and 19/16 for cat-history.

## Per level

| Level | cat-history · seed 20261109 | cat-rule · seed 20261109 | cat-danger · seed 20261109 | cat-danger-range5 · seed 20261109 | cat-history · seed 20261110 | cat-rule · seed 20261110 | cat-danger · seed 20261110 | cat-danger-range5 · seed 20261110 |
|---|---|---|---|---|---|---|---|---|
| 01_7x7_open_pass | solved 7/7 | caught @6 6/7 | caught @8 8/7 | caught @9 9/7 | solved 7/7 | solved 7/7 | solved 28/7 | solved 10/7 |
| 02_7x7_open_detour | caught @5 5/8 | solved 35/8 | solved 17/8 | solved 9/8 | caught @4 4/8 | caught @13 13/8 | caught @20 20/8 | solved 17/8 |
| 03_11x11_open_pass | solved 16/12 | caught @4 4/12 | caught @17 17/12 | solved 23/12 | caught @3 3/12 | solved 18/12 | caught @3 3/12 | caught @33 33/12 |
| 04_11x11_open_detour | solved 13/12 | solved 20/12 | solved 39/12 | solved 45/12 | solved 14/12 | solved 26/12 | solved 30/12 | solved 34/12 |
| 05_11x11_corridor_loop | caught @20 20/34 | caught @44 44/34 | solved 49/34 | step-cap 102/34 | not run | not run | not run | not run |
| 06_15x15_open_detour | solved 19/16 | caught @21 21/16 | caught @29 29/16 | solved 48/16 | not run | not run | not run | not run |

## Catches

For each catch: whether the cat was sensed, its last moves, the options exactly as shown, and the move chosen.

- **cat-rule**, 01_7x7_open_pass, seed 20261109, turn 6 (the cat landed on the mouse). Sensed: 2 block(s) down; the cat's last moves: down, down, down; told: "You sense the cat two blocks down of you. Its last three moves were down, down, down." Chose **DOWN** from:

    LEFT: colder, the smell grows weaker.
    DOWN: warmer, the smell grows stronger.
    DOWN-LEFT: no change, the smell stays the same.
    STAY: no change, the smell stays the same.
    UP: colder, the smell grows weaker.
    UP-LEFT: much colder, the smell grows much weaker.

- **cat-danger**, 01_7x7_open_pass, seed 20261109, turn 8 (the cat landed on the mouse). Sensed: 1 block(s) down; the cat's last moves: down, up, up; told: "You sense the cat one block down of you. Its last three moves were down, up, up." Chose **STAY** from:

    STAY: danger, next to the cat; no change, the smell stays the same.
    UP-LEFT: further from the cat; much colder, the smell grows much weaker.
    UP: further from the cat; colder, the smell grows weaker.
    DOWN: danger, next to the cat; warmer, the smell grows stronger.
    DOWN-LEFT: danger, next to the cat; no change, the smell stays the same.
    LEFT: danger, next to the cat; colder, the smell grows weaker.

- **cat-danger-range5**, 01_7x7_open_pass, seed 20261109, turn 9 (the cat landed on the mouse). Sensed: 1 block(s) down; the cat's last moves: up, up, up; told: "You sense the cat one block down of you. Its last three moves were up, up, up." Chose **STAY** from:

    LEFT: danger, next to the cat; colder, the smell grows weaker.
    DOWN: danger, next to the cat; warmer, the smell grows stronger.
    STAY: danger, next to the cat; no change, the smell stays the same.
    DOWN-LEFT: danger, next to the cat; no change, the smell stays the same.

- **cat-history**, 02_7x7_open_detour, seed 20261109, turn 5 (moved onto the cat). Sensed: 1 block(s) down; the cat's last moves: left, left, left; told: "You sense the cat one block down of you. Its last three moves were left, left, left." Chose **DOWN** from:

    UP: colder, the smell grows weaker.
    STAY: no change, the smell stays the same.
    DOWN: warmer, the smell grows stronger.

- **cat-rule**, 03_11x11_open_pass, seed 20261109, turn 4 (the cat landed on the mouse). Sensed: 2 block(s) down-right; the cat's last moves: left, left, left; told: "You sense the cat two blocks down-right of you. Its last three moves were left, left, left." Chose **DOWN-RIGHT** from:

    UP-RIGHT: no change, the smell stays the same.
    DOWN-RIGHT: much warmer, the smell grows much stronger.
    RIGHT: warmer, the smell grows stronger.
    UP: colder, the smell grows weaker.
    STAY: no change, the smell stays the same.
    DOWN: warmer, the smell grows stronger.

- **cat-danger**, 03_11x11_open_pass, seed 20261109, turn 17 (the cat landed on the mouse). Sensed: 2 block(s) down-right; the cat's last moves: left, left, left; told: "You sense the cat two blocks down-right of you. Its last three moves were left, left, left." Chose **DOWN-RIGHT** from:

    STAY: no change, the smell stays the same.
    UP: colder, the smell grows weaker.
    DOWN-RIGHT: danger, next to the cat; much warmer, the smell grows much stronger.
    DOWN-LEFT: further from the cat; no change, the smell stays the same.
    LEFT: further from the cat; colder, the smell grows weaker.
    UP-RIGHT: no change, the smell stays the same.
    RIGHT: danger, next to the cat; warmer, the smell grows stronger.
    DOWN: warmer, the smell grows stronger.
    UP-LEFT: further from the cat; much colder, the smell grows much weaker.

- **cat-history**, 05_11x11_corridor_loop, seed 20261109, turn 20 (moved onto the cat). Sensed: 1 block(s) down; the cat's last moves: down, down, up; told: "You sense the cat one block down of you. Its last three moves were down, down, up." Chose **DOWN** from:

    LEFT: colder, the smell grows weaker.
    DOWN: warmer, the smell grows stronger.
    STAY: no change, the smell stays the same.
    UP: colder, the smell grows weaker.

- **cat-rule**, 05_11x11_corridor_loop, seed 20261109, turn 44 (moved onto the cat). Sensed: 1 block(s) down; the cat's last moves: down, down, up; told: "You sense the cat one block down of you. Its last three moves were down, down, up." Chose **DOWN** from:

    DOWN: warmer, the smell grows stronger.
    STAY: no change, the smell stays the same.
    UP: colder, the smell grows weaker.
    LEFT: colder, the smell grows weaker.

- **cat-rule**, 06_15x15_open_detour, seed 20261109, turn 21 (moved onto the cat). Sensed: 1 block(s) down; the cat's last moves: up, up, up; told: "You sense the cat one block down of you. Its last three moves were up, up, up." Chose **DOWN** from:

    DOWN: warmer, the smell grows stronger.
    STAY: no change, the smell stays the same.
    UP: colder, the smell grows weaker.

- **cat-danger**, 06_15x15_open_detour, seed 20261109, turn 29 (the cat landed on the mouse). Sensed: 1 block(s) up; the cat's last moves: up, down, down; told: "You sense the cat one block up of you. Its last three moves were up, down, down." Chose **STAY** from:

    DOWN-RIGHT: further from the cat; no change, the smell stays the same.
    STAY: danger, next to the cat; no change, the smell stays the same.
    DOWN: further from the cat; warmer, the smell grows stronger.
    RIGHT: danger, next to the cat; colder, the smell grows weaker.
    UP: danger, next to the cat; colder, the smell grows weaker.
    UP-RIGHT: danger, next to the cat; much colder, the smell grows much weaker.

- **cat-history**, 02_7x7_open_detour, seed 20261110, turn 4 (the cat landed on the mouse). Sensed: 2 block(s) down-right; the cat's last moves: left, left, left; told: "You sense the cat two blocks down-right of you. Its last three moves were left, left, left." Chose **DOWN** from:

    UP: colder, the smell grows weaker.
    DOWN: warmer, the smell grows stronger.
    STAY: no change, the smell stays the same.

- **cat-rule**, 02_7x7_open_detour, seed 20261110, turn 13 (moved onto the cat). Sensed: 1 block(s) down; the cat's last moves: left, left, left; told: "You sense the cat one block down of you. Its last three moves were left, left, left." Chose **DOWN** from:

    STAY: no change, the smell stays the same.
    DOWN: warmer, the smell grows stronger.
    UP: colder, the smell grows weaker.

- **cat-danger**, 02_7x7_open_detour, seed 20261110, turn 20 (the cat landed on the mouse). Sensed: 1 block(s) up; the cat's last moves: left, left, left; told: "You sense the cat one block up of you. Its last three moves were left, left, left." Chose **UP-LEFT** from:

    UP-LEFT: danger, next to the cat; much colder, the smell grows much weaker.
    RIGHT: danger, next to the cat; warmer, the smell grows stronger.
    LEFT: danger, next to the cat; colder, the smell grows weaker.
    UP: danger, next to the cat; colder, the smell grows weaker.
    UP-RIGHT: danger, next to the cat; no change, the smell stays the same.
    STAY: danger, next to the cat; no change, the smell stays the same.

- **cat-history**, 03_11x11_open_pass, seed 20261110, turn 3 (moved onto the cat). Sensed: 1 block(s) right; the cat's last moves: left, left; told: "You sense the cat one block right of you. Its last two moves were left, left." Chose **RIGHT** from:

    STAY: no change, the smell stays the same.
    LEFT: colder, the smell grows weaker.
    UP: colder, the smell grows weaker.
    UP-LEFT: much colder, the smell grows much weaker.
    RIGHT: warmer, the smell grows stronger.
    UP-RIGHT: no change, the smell stays the same.
    DOWN: warmer, the smell grows stronger.
    DOWN-LEFT: no change, the smell stays the same.

- **cat-danger**, 03_11x11_open_pass, seed 20261110, turn 3 (moved onto the cat). Sensed: 1 block(s) down-right; the cat's last moves: left, left; told: "You sense the cat one block down-right of you. Its last two moves were left, left." Chose **DOWN-RIGHT** from:

    UP-RIGHT: further from the cat; no change, the smell stays the same.
    STAY: danger, next to the cat; no change, the smell stays the same.
    DOWN: danger, next to the cat; warmer, the smell grows stronger.
    DOWN-RIGHT: danger, next to the cat; much warmer, the smell grows much stronger.
    UP-LEFT: further from the cat; much colder, the smell grows much weaker.
    UP: further from the cat; colder, the smell grows weaker.
    LEFT: further from the cat; colder, the smell grows weaker.
    DOWN-LEFT: further from the cat; no change, the smell stays the same.
    RIGHT: danger, next to the cat; warmer, the smell grows stronger.

- **cat-danger-range5**, 03_11x11_open_pass, seed 20261110, turn 33 (the cat landed on the mouse). Sensed: 2 block(s) right; the cat's last moves: left, left, left; told: "You sense the cat two blocks right of you. Its last three moves were left, left, left." Chose **RIGHT** from:

    UP: colder, the smell grows weaker.
    RIGHT: danger, next to the cat; warmer, the smell grows stronger.
    STAY: no change, the smell stays the same.
    UP-LEFT: further from the cat; much colder, the smell grows much weaker.
    UP-RIGHT: danger, next to the cat; no change, the smell stays the same.
    LEFT: further from the cat; colder, the smell grows weaker.

