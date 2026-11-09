# Level 2: cat-history (A) vs cat-position (A0)

- 2026-11-09T14:51:03.357Z · commit 430d20b (uncommitted changes) · seeds 20261109, 20261110 (the same for both variants) · Ollama qwen3:1.7b · think off, temperature 0.2
- Time used: 4.6 min of 15. Everything planned ran.
- A0 is A without the sentence about the cat's last moves. A sensed choice is safe when the mouse is not caught and does not end one block from the cat.

| Variant | Completed | Caught | Steps / shortest safe (completed) | Safe when sensed | Invalid | Latency mean |
|---|---:|---:|---|---:|---:|---:|
| cat-history | 7/12 | 5 | 7/7, 16/12, 13/12, 19/16, 7/7, 14/12, 22/16 | 54/68 (79%) | 0 | 936 ms |
| cat-position | 6/12 | 6 | 7/7, 15/12, 41/34, 22/16, 15/12, 19/16 | 44/57 (77%) | 0 | 862 ms |

## Per level

| Level | cat-history · seed 20261109 | cat-position · seed 20261109 | cat-history · seed 20261110 | cat-position · seed 20261110 |
|---|---|---|---|---|
| 01_7x7_open_pass | solved 7/7 | solved 7/7 | solved 7/7 | caught @6 6/7 |
| 02_7x7_open_detour | caught @5 5/8 | caught @4 4/8 | caught @4 4/8 | caught @5 5/8 |
| 03_11x11_open_pass | solved 16/12 | caught @3 3/12 | caught @3 3/12 | caught @4 4/12 |
| 04_11x11_open_detour | solved 13/12 | solved 15/12 | solved 14/12 | solved 15/12 |
| 05_11x11_corridor_loop | caught @20 20/34 | solved 41/34 | caught @21 21/34 | caught @16 16/34 |
| 06_15x15_open_detour | solved 19/16 | solved 22/16 | solved 22/16 | solved 19/16 |

## Catches

The cat line as shown to the mouse on the catching turn, and the move it chose.

- **cat-history**, 02_7x7_open_detour, seed 20261109, turn 5 (moved onto the cat): "You sense the cat one block down of you. Its last three moves were left, left, left." Offered UP colder · STAY no change · DOWN warmer; chose DOWN.
- **cat-position**, 02_7x7_open_detour, seed 20261109, turn 4 (the cat landed on the mouse): "You sense the cat two blocks down-right of you." Offered STAY no change · DOWN warmer · UP colder; chose DOWN. (Not shown: Its last three moves were left, left, left.)
- **cat-position**, 03_11x11_open_pass, seed 20261109, turn 3 (the cat landed on the mouse): "You sense the cat one block down-right of you." Offered DOWN-LEFT no change · UP-RIGHT no change · DOWN warmer · UP colder · LEFT colder · STAY no change · UP-LEFT much colder · RIGHT warmer · DOWN-RIGHT much warmer; chose DOWN. (Not shown: Its last two moves were left, left.)
- **cat-history**, 05_11x11_corridor_loop, seed 20261109, turn 20 (moved onto the cat): "You sense the cat one block down of you. Its last three moves were down, down, up." Offered LEFT colder · DOWN warmer · STAY no change · UP colder; chose DOWN.
- **cat-position**, 01_7x7_open_pass, seed 20261110, turn 6 (moved onto the cat): "You sense the cat one block right of you." Offered UP-LEFT much colder · STAY no change · UP colder · LEFT colder · UP-RIGHT no change · RIGHT warmer; chose RIGHT. (Not shown: Its last three moves were down, down, down.)
- **cat-history**, 02_7x7_open_detour, seed 20261110, turn 4 (the cat landed on the mouse): "You sense the cat two blocks down-right of you. Its last three moves were left, left, left." Offered UP colder · DOWN warmer · STAY no change; chose DOWN.
- **cat-position**, 02_7x7_open_detour, seed 20261110, turn 5 (moved onto the cat): "You sense the cat one block down of you." Offered DOWN warmer · UP colder · STAY no change; chose DOWN. (Not shown: Its last three moves were left, left, left.)
- **cat-history**, 03_11x11_open_pass, seed 20261110, turn 3 (moved onto the cat): "You sense the cat one block right of you. Its last two moves were left, left." Offered STAY no change · LEFT colder · UP colder · UP-LEFT much colder · RIGHT warmer · UP-RIGHT no change · DOWN warmer · DOWN-LEFT no change; chose RIGHT.
- **cat-position**, 03_11x11_open_pass, seed 20261110, turn 4 (the cat landed on the mouse): "You sense the cat one block down-right of you." Offered UP-RIGHT no change · DOWN warmer · RIGHT warmer · UP-LEFT much colder · UP colder · LEFT colder · DOWN-RIGHT much warmer · DOWN-LEFT no change · STAY no change; chose DOWN. (Not shown: Its last three moves were left, left, left.)
- **cat-history**, 05_11x11_corridor_loop, seed 20261110, turn 21 (the cat landed on the mouse): "You sense the cat two blocks down of you. Its last three moves were down, up, up." Offered DOWN warmer · STAY no change · UP colder; chose DOWN.
- **cat-position**, 05_11x11_corridor_loop, seed 20261110, turn 16 (the cat landed on the mouse): "You sense the cat two blocks up-right of you." Offered LEFT colder · RIGHT warmer · STAY no change; chose RIGHT. (Not shown: Its last three moves were down, down, down.)
