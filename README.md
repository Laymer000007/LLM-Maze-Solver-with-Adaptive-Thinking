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

## Running it

Requires Node.js 24+ and an Ollama server with the model pulled (`ollama pull qwen3:1.7b`). In a clone of this repository:

```sh
npm install
npm run gui
```

Open <http://localhost:4173>. Under **AI Settings** you set the Ollama URL, model and temperature. The default server is `http://192.168.88.100:11434`; `npm run gui -- --ollama-url http://localhost:11434` overrides it. Choose a maze, then **Start**, or **Step** for one decision at a time.

The GUI shows:
- the maze, with the path drawn through cell centres so diagonal moves are visible
- the mood score and word
- a move log: for each step, the options offered with their levels, the model's answer, whether it was valid, the mood change and the latency
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

### Checks

```sh
npm run typecheck && npm run lint && npx vitest run
```

## Code

| Path | What it does |
|---|---|
| `src/maze/maze.ts` | Maze file loading, BFS distance and smell, rotation |
| `src/game/game.ts` | The rules: 8-direction moves, smell levels, mood, step cap and stuck rule |
| `src/game/prompt.ts` | The prompt and Ollama request builder, and answer parsing |
| `src/game/random.ts` | Seeded RNG and shuffle |
| `src/llm/` | Ollama client and settings |
| `src/gui/` | The web GUI (server, solver loop, page) |
| `src/eval/` | The final evaluation |
| `mazes/` | Maze files: `#` wall, `S` start, `G` cheese |

## Results

See the latest report in `benchmark-results/final/` and the summary of earlier experiments in [`docs/FINDINGS.md`](docs/FINDINGS.md).
