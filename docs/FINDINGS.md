# Findings from the experiments

This summarises what the experiments before the final version showed. Every harness, raw result and report behind it lives at the git tag **`archive/experiments-final`** (folder `benchmark-results/` and `src/benchmark/` there). The final evaluation is in `benchmark-results/final/`.

All runs used Ollama `qwen3:1.7b` (temperature 0.2) on a small home server, and, until it was removed, the Laya API. Smell was always 101 − BFS distance to the cheese, so "toward stronger smell" means "along a shortest path". Mazes: `7x7_corridor_branch`, `7x7_open_detour`, `11x11_corridor_dead-end` and `15x15_corridor_spiral`, each in its original and rotate-180 orientation. Step cap max(3 × optimal, 60), stuck after max(50, 2 × optimal) steps without a new cell. All experiments then used 4 directions; the final game uses 8.

## 1. Numbers vs words

The original prompt gave each direction numeric scores (EiL change, health, visits, smell). Rewriting it in words, with no digits, was the biggest single gain. Four 7×7 entries (2026-10-23):

| Policy (Ollama) | Completed | Wall choices | Toward stronger smell |
|---|---:|---:|---:|
| numbers baseline | 1/4 | 48/169 (28%) | 39% |
| words, look-ahead ("the smell grows stronger that way", plus visit words) | 3/4 | 0 | 60% |
| words, feedback on the last step instead of look-ahead | 0/4 | 51/228 (22%) | 42% |
| scorer (no model, always the best score) | 4/4 | 0 | 100% |

Telling the mouse what each option *will* do beat telling it what the last step *did*. Offering only legal directions removed wall choices, and the numbers prompts that listed walls drew them often.

## 2. Rule ablations (100 frozen decision states, single step)

| Prompt | Rule | Toward stronger (Ollama) |
|---|---|---:|
| look-ahead with visit words | none | 60% |
| look-ahead with visit words | full rule | 81% |
| only "warmer/colder" per option | full rule | **96%** |
| only "warmer/colder" per option | positive half only ("Always move…", no "Never…") | 88% |
| smell phrase only ("the smell grows stronger") | full rule | 94% |
| smell phrase only | positive half only | 95% |

The full rule was: "The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker." Fewer, consistent cues plus an explicit rule worked best for Qwen, and dropping the "Never…" sentence cost 8 points with warmer/colder labels. For Laya, the positive-only rule scored 100% and the rule's placement (instructions vs state) changed 2–4 answers out of 100.

The locked-in Ollama prompt (warmer/colder with the full rule) then solved **8/8** maze entries with 0 wall choices: 20/8, 10/8, 16/8, 8/8, 36/32, 36/32, 102/96 and 98/96 steps (number of steps / optimal). The numbers baseline solved 1/7 with 22% wall choices.

## 3. Laya's RIGHT bias and the compass fix

Laya, given the same warmer/colder prompt, solved only 4/8 entries. Replaying its answers showed a label bias: whenever RIGHT was offered and colder, Laya still chose it.

| Options (in the order shown) | Times | Laya chose |
|---|---:|---|
| LEFT: warmer; RIGHT: colder | 146 | left ✓ |
| DOWN: warmer; RIGHT: colder | 121 | **right ✗** |
| RIGHT: colder; DOWN: warmer | 103 | **right ✗** |
| UP: warmer; RIGHT: colder | 15 | **right ✗** |

An exhaustive test of every option set (504 requests per label scheme) by label wording:

| Labels | Correct | "up/down + right" sets |
|---|---:|---:|
| UP/DOWN/LEFT/RIGHT | 96% | 67–71% |
| NORTH/SOUTH/WEST/EAST | **99%** | 100% |
| neutral (A/B/C/D) | 96% | 100% |

With compass labels Laya solved 8/8 entries at exactly the optimal step count. (Laya has since been removed from the project.)

## 4. Qwen3 with compass labels

The same swap hurt Qwen3:

| Labels | Single step (200 situations) | Mazes | Wall/unoffered choices in mazes |
|---|---:|---|---:|
| UP/DOWN/LEFT/RIGHT | 99% | 8/8, 102 and 98 steps on the spirals (optimal 96) | 0/326 |
| NORTH/SOUTH/… | 97% | 8/8, 119 and 111 steps on the spirals | 36/360 (all "south" or "north" when not offered) |

Direction words suit Qwen; compass words suited Laya. The final game keeps UP/DOWN/… labels.

## 5. Thinking on vs off

| Ollama, warmer/colder prompt | States | Toward stronger | Legal | Failed (45 s timeout) | Mean latency |
|---|---:|---:|---:|---:|---:|
| think off | 100 | 96% | 100% | 0 | 523 ms |
| think on | 15 | 33% | 33% | 10 | 40,966 ms |

Thinking made a 1.7B model about 80× slower and no better on the cases that finished. The original game's adaptive thinking (two thinking decisions after a large EiL drop) was dropped for this reason.

## 6. Where Ollama's time goes

A read-only look at the server (6 of 12 threads, context 4096, one parallel slot) and one typical warm request:

| Phase | Tokens | Time |
|---|---:|---:|
| prompt evaluation | 116 | 604 ms |
| generation (`{"move":"left"}`) | 6 | 188 ms |
| total, including overhead | | 826 ms |
| cold start (model load after the default 5-minute keep-alive) | | ≈ 4.8 s extra |

Most of the time is reading the prompt, so short prompts are faster. A fixed opening lets Ollama reuse the cached start of the prompt (`prompt_eval_cached_count` in the response).

## What went into the final version

- Words only, no digits; legal directions only, shuffled every step with a seeded RNG.
- One level word per option, plus the explicit "Always … Never …" rule.
- UP/DOWN/LEFT/RIGHT labels (extended to UP-LEFT etc. for 8 directions).
- `think: false`, temperature 0.2, and a JSON schema so the answer can only be an offered direction.
- No health, no death and no numeric scores in the prompt. Mood replaces EiL as a word-only state.
