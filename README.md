# LLM Maze Solver with Adaptive Thinking

**Version 3.0.0**

An experimental maze environment where a language model controls a mouse using local sensory information rather than a conventional pathfinding algorithm.

The mouse is not given the solution or the cheese coordinates. Instead, it perceives Sight, Smell, Touch, Experience, Health, and an Emotional Intelligence Layer (EiL), then chooses one of four movements:

`up`, `down`, `left`, or `right`.

This is an embodied decision-making experiment, not a conventional maze solver.

**Project status:** v3.0.0 release candidate, prepared for public GitHub release.

## Why this project exists

Most maze solvers calculate the correct route directly.

This project explores a different idea:

Can a small language model behave more like an animal?

The mouse can:

- make mistakes
- collide with walls
- experience negative consequences
- remember repeated bad experiences
- explore new areas
- react to scent
- lose health
- become emotionally stressed
- temporarily switch from fast decisions to deeper reasoning

The environment provides sensory evidence, but the LLM remains responsible for choosing the movement. The system does not update model weights or claim guaranteed machine-learning-style learning.

## Key features

- LLM-controlled movement
- Local visual perception
- Cheese scent sensor
- Wall collision / Touch consequences
- Persistent experience memory
- Emotional Intelligence Layer (EiL)
- Health and survival pressure
- Adaptive thinking
- Ollama support
- OpenAI-compatible cloud LLM support
- Real-time GUI and LLM logs

## What the mouse senses

- **Sight** — newly visible cells are positive evidence; previously seen cells are neutral.
- **Smell** — the mouse receives only local `Increase Smell`, `Same Smell`, or `Decrease Smell` information. The environment creates the scent field through connected maze corridors, but the mouse never receives the map or cheese coordinates.
- **Touch** — walls remain selectable actions. Wall collisions reduce EiL and Health.
- **Experience** — new locations begin positively; repeated locations become increasingly aversive, capped at `-128`.
- **EiL** — an environment-owned Emotional Intelligence Layer from `0` to `1000`, starting at `500`.
- **Health** — starts at `100%` and reaches zero when the mouse dies.

The scent field uses BFS only to calculate the virtual sensor. It never selects, vetoes, or automatically follows a route. There is no deterministic maze solver or shortest-path override.

## Adaptive thinking

The adaptive-thinking sequence is:

1. Normal decisions use fast mode, `think: false`, when the provider supports that control.
2. One event reduces EiL by at least `100`.
3. Exactly the next two LLM decisions use deeper thinking, `think: true` for Ollama.
4. The mouse automatically returns to fast mode.

This toggle is supported directly for Ollama. Generic OpenAI-compatible providers receive normal chat requests unless they expose a provider-specific equivalent. When explicit thinking control is unavailable, the maze continues normally and the GUI reports that limitation rather than pretending the provider supports it.

## EiL and Health rules

EiL is clamped to `0..1000`:

- `500` is neutral
- `1000` is extremely positive
- `0` is critical

Experience changes are:

- New location: `+2`
- Repeated visits: `0`, `-2`, `-4`, `-8`, `-16`, `-32`, `-64`, `-128` (cap `-128`)

Sensor changes are:

- Sight: New `+10`; Already Seen `0`
- Smell: Increase `+10`; Same `0`; Decrease `-10`
- Touch: Wall collision `-100` EiL and `-10%` Health

Health decreases by `-5%` every 20 physical movements. EiL thresholds at `100`, `50`, and `0` each apply a one-time Health penalty of `-33%`. The run fails when Health reaches `0%`.

## Install

Requires Node.js 24+.

```sh
git clone https://github.com/Laymer000007/LLM-Maze-Solver-with-Adaptive-Thinking.git
cd LLM-Maze-Solver-with-Adaptive-Thinking
npm install
```

For local Ollama, install [Ollama](https://ollama.com/) and pull a model, for example:

```sh
ollama pull qwen3:1.7b
npm run gui
```

Open [http://localhost:4173](http://localhost:4173), open **LLM Settings**, test the connection, save, and then start the maze.

## LLM configuration

The GUI supports:

1. **Ollama / Local** — usually `http://localhost:11434`, with a model such as `qwen3:1.7b`.
2. **OpenAI-compatible API** — a generic base URL such as `https://api.example.com/v1`, model name, temperature, and API key.

Provider settings are saved in the browser. Cloud API keys are session-only by default: they are not written to the repository, logged, or returned by the settings API. Cloud providers may charge per request or token, and a run can make many requests.

## GUI usage

1. Run `npm run gui`.
2. Open [http://localhost:4173](http://localhost:4173).
3. Open **LLM Settings**.
4. Choose Ollama or OpenAI-compatible.
5. Enter the server URL, model, temperature, and API key if needed.
6. Select **Test Connection**, then **Save Settings**.
7. Start the maze.

The GUI shows the maze, sensory state, EiL, Health, adaptive-thinking status, movement history, and LLM logs in real time.

## CLI usage

The CLI supports Ollama:

```sh
npm run agent-execute -- --model qwen3:1.7b --maze ./mazes/7x7_open_empty.txt
```

## Architecture

```text
Maze Environment
       |
       +-- Sight
       +-- Smell
       +-- Touch
       +-- Experience
       +-- Health
       |
       v
    EiL State
       |
       v
  Compact Prompt
       |
       v
      LLM
       |
       v
UP / DOWN / LEFT / RIGHT
       |
       v
Environment Consequence
```

Production code is under `src/agent`, `src/maze`, `src/llm`, `src/gui`, and `src/cli/agent-execute.ts`. Historical prompt strategies and benchmark runners are retained separately under `research/benchmarks` and are not part of the production GUI/agent path. Generated runs are ignored under `output/`.

## Screenshots

Screenshots coming soon.

## Development

```sh
npm test
npm run typecheck
npm run lint
```

## License

MIT

## Credits / Origin

This project grew from the original [toydev/llm-maze-solver](https://github.com/toydev/llm-maze-solver) project. Upstream attribution and the original MIT license are retained.
