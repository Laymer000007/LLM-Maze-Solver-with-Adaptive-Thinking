# Findings from the experiments

This summarises what the experiments before the final version showed. Every harness, raw result and report behind it lives at the git tag **`archive/experiments-final`** (folder `benchmark-results/` and `src/benchmark/` there). The final evaluation is in `benchmark-results/final/`.

All runs used Ollama `qwen3:1.7b` (temperature 0.2) on a small home server, and, until it was removed, the Laya API. Smell was always 101 − BFS distance to the cheese, so "toward stronger smell" means "along a shortest path". Mazes: `7x7_corridor_branch`, `7x7_open_detour`, `11x11_corridor_dead-end` and `15x15_corridor_spiral`, each in its original and rotate-180 orientation. Step cap max(3 × optimal, 60), stuck after max(50, 2 × optimal) steps without a new cell (the game now uses a floor of 100 instead of 60). All experiments then used 4 directions; the final game uses 8.

## Lessons

- **Words, not numbers.** Rewriting numeric scores as words was the biggest single gain (§1).
- **Offer only legal options.** Listing walls drew wall choices; offering only legal moves, enforced by the JSON enum, removed them (§1).
- **Use clear good/bad words.** One level word per option ("warmer", "colder") beat richer descriptions (§2).
- **Drop irrelevant facts.** Extra facts dilute the cue that matters: visit words, per-option cat distances (B), the cat's history (A0 vs A) (§2, Level 2).
- **State an explicit rule.** "Always … Never …" lifted smell-following from 60% to 81%, and to 96% with warmer/colder labels (§2).
- **Labels have habits.** Laya chose RIGHT even when it was colder and did better with compass words; Qwen did worse with them. Test the label set per model (§3, §4).
- **Thinking off for decisions.** Thinking made a 1.7B model about 80× slower and no better (§5).
- **A competing rule weakens the main goal everywhere.** "Prefer moves further from the cat" made the mouse follow the smell worse even with no cat in sight (D5, D3).
- **Keep safety rules always present.** Showing the cat rules only when the cat was sensed improved smell-following but nearly doubled danger choices, and caught the mouse 5 times in 10 runs (F5).
- **Danger words are ignored some of the time:** about 1 in 10 steps for C5 in its last comparison (11%), and 22–27% in the first comparison of C and C5.
- **Look-ahead belongs in code.** Telling the mouse what each option *will* do (smell, danger) worked; asking it to infer from feedback or the cat's history did not (§1, Level 2).
- **Repeat runs before trusting differences.** At temperature 0.2 the same variant on the same seed scored 5/6, then 4/6; C5 scored 7/10, then 9/10.

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

## Level 2: the patrolling cat

Six cat levels (7×7 to 15×15). A cat walks one block per turn along a fixed axis and bounces off walls. The mouse senses it within three blocks of walking distance and is caught if they meet. Full reports are in `benchmark-results/level2/`. The runs up to the E5/F5 comparison used a step-cap floor of 60; the game now uses max(3 × shortest safe, 100).

### First evaluation (one seed per level)

| Policy | Completed | Caught | Steps / shortest safe (completed) | Safe choices when the cat was sensed | −100 / −200 penalties | Latency mean / p95 |
|---|---:|---:|---|---:|---:|---:|
| greedy (ignores the cat) | 0/6 | 6 | — | 18% | 5 / 3 | — |
| planner (safe-path search) | 6/6 | 0 | all optimal | 90% | 23 / 1 | — |
| random-legal | 0/6 | 3 | — | 63% | 5 / 4 | — |
| cat-facts (B) | 2/6 | 4 | 9/8, 17/12 | 57% | 5 / 5 | 965 / 1774 ms |
| **cat-history (A)** | **5/6** | 1 | 7/7, 8/8, 16/12, 13/12, 19/16 | 84% | 22 / 3 | 970 / 1408 ms |
| cat-facts + thinking when sensed | 0/1 (dropped) | 0 | — | 4/7 | 1 / 3 | 59.7 s when sensed |

- **Per-option cat facts made it worse.** Variant B adds "…, one block from where the cat is now" to each option. It completed 2/6 against A's 5/6. All four of its catches were moves its own prompt had labelled "where the cat is now" or "one block from where the cat is now". The extra phrases seem to be read as more text next to "warmer", not as a warning.
- **Thinking timed out.** With `think: true` on sensed steps, every request hit the 60 s timeout. After three in a row the run was aborted, and the variant was dropped to stay within the 15-minute budget.

### Cat history (A) vs cat position only (A0), two seeds

A0 is A without the sentence about the cat's last three moves.

| Variant | Completed | Caught | Safe when sensed | Latency mean |
|---|---:|---:|---:|---:|
| cat-history (A) | 7/12 | 5 | 79% | 936 ms |
| cat-position (A0) | 6/12 | 6 | 77% | 862 ms |

The history sentence helps little, if at all. The bigger pattern is the same in both variants: **every catch came from choosing a "warmer" option toward the cat** (straight at it, or within 45°), with the cat one or two blocks away. Smell still beats the "stay away from the cat first" rule for this model. Results also vary from run to run even at temperature 0.2: A completed 5/6 in the first evaluation and 4/6 on the same seed here.

### Safety rule and danger labels (A, A-rule, C, C5)

Each variant changes one thing from the one before it:
- **A-rule** replaces A's rule line with "If you sense the cat, safety comes first. If an option says danger, never choose it, even if it is warmer. Follow the smell only among the other options."
- **C** adds a part at the start of each option while the cat is sensed: "danger, next to the cat" (one block or less from the cat's current cell), "closer to the cat", "further from the cat", or nothing.
- **C5** is C with the cat sensed within five blocks instead of three.

Two seeds; seed 20261110's levels 05 and 06 did not fit in the budget, so each variant has 10 runs.

| Variant | Completed | Caught | Steps / shortest safe (completed) | Safe when sensed | Latency mean / p95 |
|---|---:|---:|---|---:|---:|
| A (cat-history) | 6/10 | 4 | 7/7, 16/12, 13/12, 19/16, 7/7, 14/12 | 73% | 1028 / 1455 ms |
| A-rule | 5/10 | 5 | 35/8, 20/12, 7/7, 18/12, 26/12 | 60% | 926 / 1404 ms |
| C | 5/10 | 5 | 17/8, 39/12, 49/34, 28/7, 30/12 | 67% | 1024 / 1597 ms |
| **C5** | **7/10** | **2** | 9/8, 23/12, 45/12, 48/16, 10/7, 17/8, 34/12 | 90%* | 1076 / 1688 ms |

\*C5 counts steps up to five blocks from the cat as sensed, so its percentage is not comparable.

- Every A and A-rule catch was a "warmer" option toward a sensed cat. The stronger rule alone changed nothing.
- With danger labels the model still chose a danger option when a non-danger one was offered on 22% (C) and 27% (C5) of such steps. Of the 7 catches with labels, 5 were such choices and 2 were trapped (every option, STAY included, marked danger).
- The danger variants walk longer routes.

### A competing rule weakens the main goal (D5, D3)

D5 was C5 with two changes at once: options within one block of the cat were not offered (all kept if none would remain), and a new rule line, "If you sense the cat, stay away from it. Follow the smell, but prefer moves that take you further from the cat." D3 was D5 with three-block sensing. On seed 1 (6 levels each):

| Variant | Completed | Caught | Not sensed: chose colder |
|---|---:|---:|---:|
| C5 | 5/6 | 1 | 20% |
| D5 | 1/6 | 0 | 32% |
| D3 | 1/6 | 0 | 33% |

D was never caught but wandered until the step cap on 10 of its 12 runs, mostly with no cat in sight. The filter cannot act on those steps, because an option next to the cat is always within sensing range. The rule line was the only difference there. **A rule that adds a second goal ("prefer moves further from the cat") weakens the main one (follow the smell) even when the second goal does not apply.** Because D changed two things, this run could not tell the filter's effect from the rule's, which led to the next comparison.

### One change at a time (E5, F5)

- **E5** is C5 with D's filter only. The rule line and option text are C5's.
- **F5** is C5, but the three cat sentences in the rules appear only on steps where the cat is sensed. Otherwise the rules are level 1's, without its mood line.

Two seeds; seed 20261110's levels 05 and 06 did not fit, so each variant has 10 runs. "Not sensed" columns count steps with no cat sensed.

| Variant | Completed | Caught | Steps / shortest safe (completed) | Not sensed: colder | Not sensed: not the warmest when warmer offered | Latency mean |
|---|---:|---:|---|---:|---:|---:|
| **C5** | **9/10** | **1** | 9/8, 19/12, 42/12, 86/34, 48/16, 10/7, 17/8, 24/12, 20/12 | 17% | 57% | 1047 ms |
| E5 (filter) | 7/10 | 2 | 21/8, 18/12, 15/12, 45/16, 9/8, 26/12, 36/12 | 17% | 55% | 988 ms |
| F5 (cat rules only when sensed) | 5/10 | 5 | 15/12, 20/12, 39/34, 11/7, 20/12 | 0% | 26% | 1064 ms |

- **E5:** the filter removed 225 options on 85 of 330 steps. Both catches were trapped, with every option next to the cat, so the filter had nothing to remove. It also took the step cap once, on the corridor level.
- **F5:** with level 1's smell rule on steps with no cat sensed, smell-following improved sharply (0% colder). But it chose a danger option, when a non-danger one was offered, on 19% of such steps against C5's 11%. Four of its five catches were such choices. Switching the rules on only when the cat appears seems to make the model ignore them more often. That is a reading of 10 runs, not a measured cause.
- C5 completed 5/6 on seed 1, the same levels as in the previous comparison. Results still vary between runs, so differences of one or two runs are weak.

**The GUI uses C5** (cat-danger-range5, sensing within five blocks). Neither E5 nor F5 completed at least as many levels as C5 with fewer catches.

### Big maps (30x30 to 50x50)

Six generated maps (`src/tools/generate-big-level2.ts`): corridors with loops, junctions and some open areas, two each of 30x30, 40x40 and 50x50. Each is proven winnable by the safe-path search. Each has a cat patrol line of at least three cells that crosses a shortest route, with a way round it (start and cheese stay connected with the patrol line walled off). On all six, the cat-ignoring greedy policy is caught. Step cap max(3 × shortest safe, 100). One seed (20261109), 13.5 minutes.

| Map | Shortest safe (ignoring the cat) | Greedy | Planner | C5 |
|---|---:|---|---|---|
| 07_30x30_loops_a | 40 (40) | caught @35 | solved 40 | step cap 120 |
| 08_30x30_loops_b | 56 (40) | caught @24 | solved 56 | step cap 168 |
| 09_40x40_loops_a | 93 (85) | caught @60 | solved 93 | caught @190 |
| 10_40x40_loops_b | 95 (69) | caught @8 | solved 95 | step cap 285 |
| 11_50x50_loops_a | 59 (58) | caught @20 | solved 59 | caught @66 |
| 12_50x50_loops_b | 67 (60) | caught @53 | solved 67 | step cap 201 |

**C5 solved none of the big maps.** It was caught twice and ran out of steps four times; mean latency was 773 ms.
- **Navigation is the limit.** On steps with no cat sensed, C5 chose colder 12% of the time and something other than the warmest option, when a warmer one was offered, 49%. On the small maps that drift was survivable; on long routes with dead ends it was not. Only on 07 did it get within two steps of the cheese. On four maps it never got past "faint" (more than ten steps away).
- **Map 10 has its cat close to the start.** C5 had the cat sensed on 216 of its 285 steps there and never got away from it.
- **Both catches were danger options chosen while a non-danger one was offered:** STAY marked danger on 09, and RIGHT marked danger on 11.

Smell following, not cat avoidance, is what fails first on big maps.

## What went into the final version

- Words only, no digits; legal directions only, shuffled every step with a seeded RNG.
- One level word per option, plus the explicit "Always … Never …" rule.
- UP/DOWN/LEFT/RIGHT labels (extended to UP-LEFT etc. for 8 directions).
- `think: false`, temperature 0.2, and a JSON schema so the answer can only be an offered direction.
- No health, no death and no numeric scores in the prompt. Mood replaces EiL as a word-only state.
