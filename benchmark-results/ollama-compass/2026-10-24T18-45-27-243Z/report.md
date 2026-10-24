# Qwen3: ollama-best with direction vs compass labels

- Timestamp: 2026-10-24T18:45:27.243Z · commit 83172af519372f316d05eda72f99daecbd212127 (dirty) · seed 20261023 · qwen3:1.7b at http://192.168.88.100:11434, think:false, temperature 0.2
- ollama-best: warmer/colder options, full rule, options labelled UP/DOWN/LEFT/RIGHT, answer {"move":"up|down|left|right"}. ollama-best-compass: the same prompt with NORTH/SOUTH/EAST/WEST labels and answer {"move":"north|south|east|west"}, mapped back to moves in code. A test checks that only the option labels and the answer-format line differ.
- Single step: the same 200 situations for both arms, a seeded sample of the 504 laya-exhaustive situations (each with its canonical or shuffled option order), 1 request each. Toward = the answer is a warmer direction; legal = an offered direction; failed = no direction word in the answer.
- Time budget 15 min; used 501.7 s.
- Better arm: ollama-best (toward 197 vs 193 of 200 for moves vs compass).

## Single step

| Arm | Situations | Toward stronger | Legal | Failed | Mean latency | Mean prompt tokens |
|---|---:|---:|---:|---:|---:|---:|
| ollama-best | 200 | 197/200 (99%) | 200/200 (100%) | 0 | 527 ms | 117 |
| ollama-best-compass | 200 | 193/200 (97%) | 198/200 (99%) | 0 | 542 ms | 119 |

Same situation, both arms: both toward 192, only ollama-best 5, only compass 1, neither 2 (of 200).

## ollama-best: wrong answers (3)

| Answer (as a move) | Count |
|---|---:|
| up: offered, colder | 2 |
| right: offered, colder | 1 |

Most wrong answers by directions offered: up, right (2/8); left, right (1/11).

<details><summary>Every wrong answer</summary>

| Options (order shown, ✓ = warmer) | Closeness | Answer |
|---|---|---|
| right, left ✓ | the cheese smell is overwhelming, it must be right here | {"move":"right"} |
| right ✓, up | the smell is faint | {"move":"up"} |
| right ✓, up | the cheese smell is overwhelming, it must be right here | {"move":"up"} |

</details>

## ollama-best-compass: wrong answers (7)

| Answer (as a move) | Count |
|---|---:|
| up: offered, colder | 5 |
| down: not offered | 2 |

Most wrong answers by directions offered: left, right (2/11); up, right (2/8); up, left, right (1/24); up, down, left, right (1/45); up, down, right (1/21).

<details><summary>Every wrong answer</summary>

| Options (order shown, ✓ = warmer) | Closeness | Answer |
|---|---|---|
| right, left ✓ | the smell is faint | {"move":"south"} |
| right ✓, left ✓, up | the smell is faint | {"move":"north"} |
| right, left ✓ | the smell is strong | {"move":"south"} |
| right ✓, left ✓, down, up | the smell is faint | {"move":"north"} |
| right ✓, up | the smell is faint | {"move":"north"} |
| right ✓, up | the cheese smell is overwhelming, it must be right here | {"move":"north"} |
| right ✓, down ✓, up | the cheese smell is overwhelming, it must be right here | {"move":"north"} |

</details>

## Maze check

Same 8 entries as the earlier maze checks; step cap max(3 × optimal, 60), stuck rule max(50, 2 × optimal), option shuffle seeded as ollama-best was. Ollama samples at temperature 0.2, so repeated runs can differ.

| Policy | Completed | Steps / optimal (completed) | Stuck | Wall choices | Toward stronger smell | Mean latency | 7x7_corridor_branch@original | 7x7_corridor_branch@rotate-180 | 7x7_open_detour@original | 7x7_open_detour@rotate-180 | 11x11_corridor_dead-end@original | 11x11_corridor_dead-end@rotate-180 | 15x15_corridor_spiral@original | 15x15_corridor_spiral@rotate-180 |
|---|---:|---|---:|---:|---:|---:|---|---|---|---|---|---|---|---|
| ollama-best | 8/8 | 20/8, 12/8, 14/8, 8/8, 36/32, 36/32, 102/96, 98/96 | 0 | 0/326 | 94% | 449 ms | completed 20 | completed 12 | completed 14 | completed 8 | completed 36 | completed 36 | completed 102 | completed 98 |
| ollama-best-compass | 8/8 | 20/8, 12/8, 16/8, 8/8, 37/32, 37/32, 119/96, 111/96 | 0 | 36/360 | 85% | 355 ms | completed 20 | completed 12 | completed 16 | completed 8 | completed 37 | completed 37 | completed 119 | completed 111 |

All 36 ollama-best-compass wall choices were SOUTH (down) when south was not offered (offline count from maze-runs.json, added after the run); ollama-best made none.

Earlier ollama-best maze check (`benchmark-results/word-prompts-tuning/2026-10-24T15-17-39-284Z-maze-check`): 8/8 completed; 20/8, 10/8, 16/8, 8/8, 36/32, 36/32, 102/96, 98/96.

## Example prompts

One sampled situation (options right, up, left; warmer: up, left; the cheese smell is overwhelming, it must be right here), as the model reads it. The request body is ollamaRequestBody(model, prompt, think:false) with temperature 0.2.

### ollama-best

```text
You are a mouse in a dark maze, searching for cheese by smell.
The cheese smell is overwhelming, it must be right here.
The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.
You can go:
RIGHT: colder, the smell grows weaker.
UP: warmer, the smell grows stronger.
LEFT: warmer, the smell grows stronger.
Choose one direction.
Return only JSON: {"move":"up|down|left|right"}.
```

### ollama-best-compass

```text
You are a mouse in a dark maze, searching for cheese by smell.
The cheese smell is overwhelming, it must be right here.
The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.
You can go:
EAST: colder, the smell grows weaker.
NORTH: warmer, the smell grows stronger.
WEST: warmer, the smell grows stronger.
Choose one direction.
Return only JSON: {"move":"north|south|east|west"}.
```

