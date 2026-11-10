# LLM Maze Solver

A mouse looks for cheese in a maze. A small local language model (Ollama, `qwen3:1.7b`) chooses every move. It never sees the map, coordinates or numbers: only what its nose says about each direction, and how it feels, in plain words.

This is the final version of the project. Earlier versions, and all the experiments that led here, are kept at the git tag `archive/experiments-final`. [`docs/FINDINGS.md`](docs/FINDINGS.md) summarises what those experiments showed.

## Rules

**Movement.** Eight directions: `up, down, left, right, up-left, up-right, down-left, down-right`. A diagonal move is allowed only when the target cell **and both straight cells beside it** are open, so the mouse never squeezes between wall corners. Only legal directions are offered. An answer that is not one of them (or that can't be read) leaves the mouse where it is: the step still counts, it is logged as invalid, and it is never silently corrected.

**Smell.** Smell is 101 − the shortest-path distance to the cheese, counted in straight (4-direction) steps. Each option says how the smell changes:

| Level | Distance change | Possible for |
|---|---:|---|
| much warmer | −2 | diagonals |
| warmer | −1 | straight moves |
| no change | 0 | diagonals |
| colder | +1 | straight moves |
| much colder | +2 | diagonals |

The current cell gets one closeness sentence, chosen by distance: overwhelming (≤ 2), strong (≤ 5), noticeable (≤ 10) or faint.

**Mood.** Mood is a score from 0 to 1,000 that starts at 500. Each move changes it: much warmer +20, warmer +10, no change 0, colder −10, much colder −20, and an invalid answer −30. The prompt gives only the word:

| Score | Mood |
|---|---|
| 800–1,000 | extremely happy |
| 600–799 | happy |
| 400–599 | normal |
| 200–399 | anxious |
| 0–199 | extremely depressed |

Mood only describes the run: it has no other effect and the mouse cannot die. A run ends at the cheese, at the step cap of max(3 × optimal, 60) steps, or when the mouse is stuck: no new cell reached in max(50, 2 × optimal) steps.

## The prompt

One builder (`src/game/prompt.ts`) serves both the GUI and the evaluation. The fixed text comes first, so Ollama can reuse the cached start of the prompt. The options are the legal directions, in a seeded random order every step. The prompt contains no digits. An example:

```text
You are a mouse in a maze, looking for the cheese.
The cheese is where the smell is strongest. Always move where the smell grows stronger, and prefer much warmer over warmer. Never choose a direction where the smell grows weaker.
Warmer moves lift your mood, colder moves lower it.

Right now:
The cheese smell is strong.
Your mood is happy.

You can go:
UP-RIGHT: much warmer, the smell grows much stronger, your mood rises a lot.
LEFT: colder, the smell grows weaker, your mood drops.
DOWN: warmer, the smell grows stronger, your mood rises.
Choose one direction.
Return only JSON: {"move":"up-right|left|down"}.
```

Every request sets `think: false`, `stream: false` and temperature 0.2 (the GUI lets you change the temperature). Its `format` is a JSON schema whose `move` enum is exactly the offered directions.

## Level 2: the patrolling cat

Level 2 uses the same rules and smell as level 1, plus a cat. Its levels are in `mazes/level2/*.json`: each file holds a layout and the cat's start cell, patrol axis (`horizontal` or `vertical`) and starting direction.

**The cat.** Each turn it moves one block along its axis. At a wall or the edge it turns around and moves one block the other way in the same turn; if both sides are blocked it stays put. It ignores the mouse and is fully deterministic. The cheese doesn't stop it.

**The mouse** has the 8 directions plus `stay`. Each turn runs in this order:
1. The mouse moves (or stays). If it is now on the cat's cell, it is caught. If it is on the cheese, it wins and the cat doesn't move.
2. The cat moves. If it lands on the mouse, or the two swapped cells, the mouse is caught.
3. Mood is updated: the smell change as in level 1 (`stay` counts as no change), then −200 if the cat is one block away or −100 if it is two (the penalties don't add up).

A catch ends the run as failed. Otherwise the run ends at the cheese, the step cap (max(3 × shortest safe path, 60)) or the stuck rule.

**Distance to the cat** is always the walking distance through open cells, under the same 8-direction rules, never through walls. In the GUI the mouse senses the cat within five blocks (three for most evaluation variants); the mood penalties stay at one and two blocks. It is then told the cat's direction, its distance in words and its last three moves (oldest first, "stayed" for a turn without moving). It is never told the cat's next move or its axis.

**Solvability.** A breadth-first search over (mouse cell, cat cell, cat direction) proves each level winnable and gives the shortest safe number of steps (`shortestSafePath` in `src/game/level2.ts`).

The GUI sends the **cat-danger-range5** prompt (C5 in the findings):

```text
You are a mouse in a maze, looking for the cheese. A cat patrols the maze: it walks in a straight line, one block per move, and turns around when it hits a wall. If the cat catches you, you fail.
If you sense the cat, safety comes first. If an option says danger, never choose it, even if it is warmer. Follow the smell only among the other options.
Being near the cat ruins your mood.

Right now:
The cheese smell is noticeable.
Your mood is normal.
You sense the cat two blocks down-right of you. Its last two moves were up, down.

You can go:
DOWN-RIGHT: danger, next to the cat; much warmer, the smell grows much stronger.
STAY: no change, the smell stays the same.
RIGHT: danger, next to the cat; warmer, the smell grows stronger.
DOWN-LEFT: further from the cat; no change, the smell stays the same.
DOWN: warmer, the smell grows stronger.
LEFT: further from the cat; colder, the smell grows weaker.
Choose one direction.
Return only JSON: {"move":"down-right|stay|right|down-left|down|left"}.
```

While the cat is sensed, each option starts with what it does relative to the cat's current cell: "danger, next to the cat" (one block or less), "closer to the cat", "further from the cat", or nothing if the distance doesn't change. When the cat isn't sensed, the cat line reads "You can't sense the cat." and the options carry no cat part. The options have no mood phrase, because each option's effect on mood depends on the cat's next move, which the mouse isn't told. The other variants (`Level2Variant` in `src/game/prompt.ts`) exist for evaluation; [docs/FINDINGS.md](docs/FINDINGS.md) compares them.

## Running it

Requires Node.js 24+ and an Ollama server with the model pulled (`ollama pull qwen3:1.7b`). In a clone of this repository:

```sh
npm install
npm run gui
```

Open <http://localhost:4173>. Pick **Level 1** or **Level 2** and a maze for that level. Under **AI Settings** you set the Ollama URL, model and temperature. The default server is `http://192.168.88.100:11434`; `npm run gui -- --ollama-url http://localhost:11434` overrides it. Choose a maze, then **Start**, or **Step** for one decision at a time.

The GUI shows:
- the maze, with the path drawn through cell centres so diagonal moves are visible
- the mood score and word
- a move log: for each step, the options offered with their levels, the model's answer, whether it was valid, the mood change and the latency
- on level 2, the cat (drawn after the mouse moves), the cat line the mouse was told, and mood penalties; STAY moves are marked with a dashed ring
- a diagnostics panel with the exact request sent

An Ollama error stops the run with a clear message; there is no fallback. Settings can't be changed while a request is in flight.

### Evaluation

```sh
npm run eval:final
```

The evaluation runs in two parts, all within a 15-minute budget:
1. **Single step.** 200 sampled situations, each sent with two prompt variants: **full**, the prompt above, and **smell-only**, the same without any mood text.
2. **Mazes.** The 8 maze entries, played by both variants and by two baselines with no model: **greedy** (always the warmest option) and **random-legal**.

It writes `benchmark-results/final/<timestamp>/report.md`.

```sh
npm run eval:level2
npm run eval:level2 -- --compare cat-danger-range5,cat-danger-range5-filter
```

The first command runs the six cat levels: the free policies (greedy, which ignores the cat; the planner, which follows the safe-path search; random-legal), then cat-facts, cat-history, and cat-facts with thinking when the cat is sensed. The second compares any prompt variants on every level with two seeds, seed by seed, and counts only the levels and seeds that every variant finished. Both write to `benchmark-results/level2/`.

### Checks

```sh
npm run typecheck && npm run lint && npx vitest run
```

## Code

| Path | What it does |
|---|---|
| `src/maze/maze.ts` | Maze file loading, BFS distance and smell, rotation |
| `src/game/game.ts` | The rules: 8-direction moves, smell levels, mood, step cap and stuck rule |
| `src/game/level2.ts` | Level 2: the cat, stay, turn order and catches, walking distance, sensing, the safe-path search |
| `src/game/prompt.ts` | The level-1 and level-2 prompt and Ollama request builders, and answer parsing |
| `src/game/random.ts` | Seeded RNG and shuffle |
| `src/llm/` | Ollama client and settings |
| `src/gui/` | The web GUI (server, solver loop, page) |
| `src/eval/` | The level-1 and level-2 evaluations |
| `mazes/` | Maze files: `#` wall, `S` start, `G` cheese; `mazes/level2/` adds the cat |

## Results

See the latest reports in `benchmark-results/final/` and `benchmark-results/level2/` and the summary of earlier experiments in [`docs/FINDINGS.md`](docs/FINDINGS.md).
