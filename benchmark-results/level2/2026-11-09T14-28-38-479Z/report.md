# Level 2 evaluation: the patrolling cat

- 2026-11-09T14:28:38.479Z · commit 0015aab (uncommitted changes) · seed 20261109 · Ollama qwen3:1.7b · temperature 0.2, JSON-schema answer
- Time used: 14.8 min of 15. Not run (budget): 02_7x7_open_detour/cat-facts+think (stopped mid-run), 03_11x11_open_pass/cat-facts+think, 04_11x11_open_detour/cat-facts+think, 05_11x11_corridor_loop/cat-facts+think, 06_15x15_open_detour/cat-facts+think.
- Levels: 01_7x7_open_pass (shortest safe 7), 02_7x7_open_detour (shortest safe 8), 03_11x11_open_pass (shortest safe 12), 04_11x11_open_detour (shortest safe 12), 05_11x11_corridor_loop (shortest safe 34), 06_15x15_open_detour (shortest safe 16). Step cap max(3 × shortest safe, 60); stuck when no new cell for max(50, 2 × shortest safe) steps.
- **cat-history** (A): the cat line only. **cat-facts** (B): also each option's walking distance to the cat's current cell. **cat-facts+think**: B with think on (60 s timeout) only on steps where the cat is sensed. **planner** follows the safe-path search; **greedy** ignores the cat.
- A sensed choice is *safe* when the mouse is not caught and does not end one block from the cat after its move.

## Per policy

| Policy | Completed | Caught | Steps / shortest safe (completed) | Final mood (mean) | −100 / −200 penalties | Safe when sensed | Invalid | Latency mean / p95 |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| greedy | 0/6 | 6 | — | 402 | 5 / 3 | 2/11 (18%) | 0 | — |
| planner | 6/6 | 0 | 7/7, 8/8, 12/12, 12/12, 34/34, 16/16 | 257 | 23 / 1 | 26/29 (90%) | 0 | — |
| random-legal | 0/6 | 3 | — | 338 | 5 / 4 | 12/19 (63%) | 0 | — |
| cat-facts | 2/6 | 4 | 9/8, 17/12 | 352 | 5 / 5 | 12/21 (57%) | 0 | 965 ms / 1774 ms |
| cat-history | 5/6 | 1 | 7/7, 8/8, 16/12, 13/12, 19/16 | 205 | 22 / 3 | 31/37 (84%) | 0 | 970 ms / 1408 ms |
| cat-facts+think | 0/1 | 0 | — | 0 | 1 / 3 | 4/7 (57%) | 6 | 20533 ms / 59661 ms |

Thinking variant latency: sensed steps (think on) 59661 ms mean / 59661 ms p95; not sensed (think off) 969 ms / 1169 ms. Failed requests: 6.

## Per level

| Level | greedy | planner | random-legal | cat-facts | cat-history | cat-facts+think |
|---|---|---|---|---|---|---|
| 01_7x7_open_pass | caught @4 4/7 · mood 260 | solved 7/7 · mood 280 | caught @20 20/7 · mood 260 | caught @7 7/7 · mood 270 | solved 7/7 · mood 280 | aborted 9/7 · mood 0 |
| 02_7x7_open_detour | caught @4 4/8 · mood 450 | solved 8/8 · mood 180 | step-cap 60/8 · mood 490 | solved 9/8 · mood 280 | solved 8/8 · mood 180 | not run |
| 03_11x11_open_pass | caught @3 3/12 · mood 350 | solved 12/12 · mood 460 | caught @7 7/12 · mood 0 | caught @3 3/12 · mood 440 | solved 16/12 · mood 100 | not run |
| 04_11x11_open_detour | caught @6 6/12 · mood 490 | solved 12/12 · mood 60 | step-cap 60/12 · mood 530 | solved 17/12 · mood 560 | solved 13/12 · mood 60 | not run |
| 05_11x11_corridor_loop | caught @16 16/34 · mood 560 | solved 34/34 · mood 480 | step-cap 102/34 · mood 580 | caught @21 21/34 · mood 460 | caught @19 19/34 · mood 370 | not run |
| 06_15x15_open_detour | caught @6 6/16 · mood 300 | solved 16/16 · mood 80 | caught @25 25/16 · mood 170 | caught @7 7/16 · mood 100 | solved 19/16 · mood 240 | not run |

## Catches

- greedy on 01_7x7_open_pass: turn 4, moved onto the cat
- greedy on 02_7x7_open_detour: turn 4, the cat landed on the mouse
- greedy on 03_11x11_open_pass: turn 3, moved onto the cat
- greedy on 04_11x11_open_detour: turn 6, the cat landed on the mouse
- greedy on 05_11x11_corridor_loop: turn 16, the cat landed on the mouse
- greedy on 06_15x15_open_detour: turn 6, the cat landed on the mouse
- random-legal on 01_7x7_open_pass: turn 20, moved onto the cat
- random-legal on 03_11x11_open_pass: turn 7, moved onto the cat
- random-legal on 06_15x15_open_detour: turn 25, the cat landed on the mouse
- cat-facts on 01_7x7_open_pass: turn 7, moved onto the cat
- cat-facts on 03_11x11_open_pass: turn 3, the cat landed on the mouse
- cat-facts on 05_11x11_corridor_loop: turn 21, moved onto the cat
- cat-facts on 06_15x15_open_detour: turn 7, moved onto the cat
- cat-history on 05_11x11_corridor_loop: turn 19, the cat landed on the mouse

## Unsafe choices with the cat sensed: one example of each kind per policy

- **cat-facts, ended one block from the cat:** 01_7x7_open_pass turn 6. Cat sensed 2 block(s) right, history [down, down, down]. Offered RIGHT warmer · UP colder · STAY no change · UP-LEFT much colder · LEFT colder · UP-RIGHT no change; chose RIGHT.
- **cat-facts, moved onto the cat:** 01_7x7_open_pass turn 7. Cat sensed 1 block(s) up-right, history [down, down, up]. Offered UP-RIGHT no change · STAY no change · UP colder · RIGHT warmer · UP-LEFT much colder · LEFT colder; chose UP-RIGHT.
- **cat-facts, the cat landed on the mouse:** 03_11x11_open_pass turn 3. Cat sensed 2 block(s) down-right, history [left, left]. Offered DOWN-LEFT no change · DOWN-RIGHT much warmer · UP-RIGHT no change · DOWN warmer · LEFT colder · UP colder · UP-LEFT much colder · RIGHT warmer · STAY no change; chose DOWN-RIGHT.
- **cat-history, ended one block from the cat:** 01_7x7_open_pass turn 6. Cat sensed 2 block(s) down-right, history [down, down, down]. Offered DOWN warmer · LEFT colder · STAY no change · DOWN-LEFT no change · RIGHT warmer · DOWN-RIGHT much warmer; chose DOWN-RIGHT.
- **cat-history, the cat landed on the mouse:** 05_11x11_corridor_loop turn 19. Cat sensed 2 block(s) down, history [down, down, down]. Offered LEFT colder · UP colder · DOWN warmer · STAY no change; chose DOWN.
- **cat-facts+think, ended one block from the cat:** 01_7x7_open_pass turn 7. Cat sensed 2 block(s) down-right, history [down, down, up]. Offered LEFT colder · DOWN warmer · UP-RIGHT no change · RIGHT warmer · DOWN-RIGHT much warmer · UP-LEFT much colder · STAY no change · UP colder; chose nothing valid.

## Notes (added after the run)

- **Default GUI choice:** cat-history (A) completed 5/6 and cat-facts (B) 2/6, so by the rule (most completed) the GUI would use **cat-history**.
- **Thinking:** every thinking request (cat sensed) hit the 60 s timeout. After three timeouts in a row the run on the first level was aborted (counted as 6 invalid answers: the timeouts and the steps in between). The variant was then dropped, because another thinking request might not fit in the budget. It used about 7 of the 15 minutes.
- The planner is "safe when sensed" on only 90% of steps: the safe-path search avoids being caught, not ending next to the cat. It does end one block away 3 times, and takes 23 −100 penalties on the way.
- The per-option distances in B did not help: B walked into the cat four times, choosing a warmer option that its own prompt marked as "where the cat is now" or "one block from where the cat is now".

## Example prompts

### cat-history/sensed

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a maze, looking for the cheese. A cat patrols the maze: it walks in a straight line, one block per move, and turns around when it hits a wall. If the cat catches you, you fail.\nStay away from the cat first: never move next to it. Then follow the smell: always move where the smell grows stronger, and prefer much warmer over warmer.\nBeing near the cat ruins your mood.\n\nRight now:\nThe cheese smell is noticeable.\nYour mood is normal.\nYou sense the cat three blocks right of you. Its last move was up.\n\nYou can go:\nSTAY: no change, the smell stays the same.\nDOWN: warmer, the smell grows stronger.\nRIGHT: warmer, the smell grows stronger.\nLEFT: colder, the smell grows weaker.\nDOWN-RIGHT: much warmer, the smell grows much stronger.\nDOWN-LEFT: no change, the smell stays the same.\nChoose one direction.\nReturn only JSON: {\"move\":\"stay|down|right|left|down-right|down-left\"}."
    }
  ],
  "stream": false,
  "think": false,
  "format": {
    "type": "object",
    "properties": {
      "move": {
        "type": "string",
        "enum": [
          "stay",
          "down",
          "right",
          "left",
          "down-right",
          "down-left"
        ]
      }
    },
    "required": [
      "move"
    ]
  },
  "options": {
    "temperature": 0.2
  }
}
```

```text
You are a mouse in a maze, looking for the cheese. A cat patrols the maze: it walks in a straight line, one block per move, and turns around when it hits a wall. If the cat catches you, you fail.
Stay away from the cat first: never move next to it. Then follow the smell: always move where the smell grows stronger, and prefer much warmer over warmer.
Being near the cat ruins your mood.

Right now:
The cheese smell is noticeable.
Your mood is normal.
You sense the cat three blocks right of you. Its last move was up.

You can go:
STAY: no change, the smell stays the same.
DOWN: warmer, the smell grows stronger.
RIGHT: warmer, the smell grows stronger.
LEFT: colder, the smell grows weaker.
DOWN-RIGHT: much warmer, the smell grows much stronger.
DOWN-LEFT: no change, the smell stays the same.
Choose one direction.
Return only JSON: {"move":"stay|down|right|left|down-right|down-left"}.
```

### cat-facts/sensed

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a maze, looking for the cheese. A cat patrols the maze: it walks in a straight line, one block per move, and turns around when it hits a wall. If the cat catches you, you fail.\nStay away from the cat first: never move next to it. Then follow the smell: always move where the smell grows stronger, and prefer much warmer over warmer.\nBeing near the cat ruins your mood.\n\nRight now:\nThe cheese smell is noticeable.\nYour mood is normal.\nYou sense the cat three blocks up-right of you. Its last move was up.\n\nYou can go:\nDOWN: warmer, the smell grows stronger, far from where the cat is now.\nLEFT: colder, the smell grows weaker, far from where the cat is now.\nDOWN-LEFT: no change, the smell stays the same, far from where the cat is now.\nUP-RIGHT: no change, the smell stays the same, two blocks from where the cat is now.\nUP: colder, the smell grows weaker, three blocks from where the cat is now.\nRIGHT: warmer, the smell grows stronger, two blocks from where the cat is now.\nSTAY: no change, the smell stays the same, three blocks from where the cat is now.\nUP-LEFT: much colder, the smell grows much weaker, far from where the cat is now.\nChoose one direction.\nReturn only JSON: {\"move\":\"down|left|down-left|up-right|up|right|stay|up-left\"}."
    }
  ],
  "stream": false,
  "think": false,
  "format": {
    "type": "object",
    "properties": {
      "move": {
        "type": "string",
        "enum": [
          "down",
          "left",
          "down-left",
          "up-right",
          "up",
          "right",
          "stay",
          "up-left"
        ]
      }
    },
    "required": [
      "move"
    ]
  },
  "options": {
    "temperature": 0.2
  }
}
```

```text
You are a mouse in a maze, looking for the cheese. A cat patrols the maze: it walks in a straight line, one block per move, and turns around when it hits a wall. If the cat catches you, you fail.
Stay away from the cat first: never move next to it. Then follow the smell: always move where the smell grows stronger, and prefer much warmer over warmer.
Being near the cat ruins your mood.

Right now:
The cheese smell is noticeable.
Your mood is normal.
You sense the cat three blocks up-right of you. Its last move was up.

You can go:
DOWN: warmer, the smell grows stronger, far from where the cat is now.
LEFT: colder, the smell grows weaker, far from where the cat is now.
DOWN-LEFT: no change, the smell stays the same, far from where the cat is now.
UP-RIGHT: no change, the smell stays the same, two blocks from where the cat is now.
UP: colder, the smell grows weaker, three blocks from where the cat is now.
RIGHT: warmer, the smell grows stronger, two blocks from where the cat is now.
STAY: no change, the smell stays the same, three blocks from where the cat is now.
UP-LEFT: much colder, the smell grows much weaker, far from where the cat is now.
Choose one direction.
Return only JSON: {"move":"down|left|down-left|up-right|up|right|stay|up-left"}.
```

### cat-facts/not sensed

```json
{
  "model": "qwen3:1.7b",
  "messages": [
    {
      "role": "user",
      "content": "You are a mouse in a maze, looking for the cheese. A cat patrols the maze: it walks in a straight line, one block per move, and turns around when it hits a wall. If the cat catches you, you fail.\nStay away from the cat first: never move next to it. Then follow the smell: always move where the smell grows stronger, and prefer much warmer over warmer.\nBeing near the cat ruins your mood.\n\nRight now:\nThe cheese smell is noticeable.\nYour mood is normal.\nYou can't sense the cat.\n\nYou can go:\nDOWN-RIGHT: much warmer, the smell grows much stronger.\nDOWN: warmer, the smell grows stronger.\nSTAY: no change, the smell stays the same.\nRIGHT: warmer, the smell grows stronger.\nChoose one direction.\nReturn only JSON: {\"move\":\"down-right|down|stay|right\"}."
    }
  ],
  "stream": false,
  "think": false,
  "format": {
    "type": "object",
    "properties": {
      "move": {
        "type": "string",
        "enum": [
          "down-right",
          "down",
          "stay",
          "right"
        ]
      }
    },
    "required": [
      "move"
    ]
  },
  "options": {
    "temperature": 0.2
  }
}
```

```text
You are a mouse in a maze, looking for the cheese. A cat patrols the maze: it walks in a straight line, one block per move, and turns around when it hits a wall. If the cat catches you, you fail.
Stay away from the cat first: never move next to it. Then follow the smell: always move where the smell grows stronger, and prefer much warmer over warmer.
Being near the cat ruins your mood.

Right now:
The cheese smell is noticeable.
Your mood is normal.
You can't sense the cat.

You can go:
DOWN-RIGHT: much warmer, the smell grows much stronger.
DOWN: warmer, the smell grows stronger.
STAY: no change, the smell stays the same.
RIGHT: warmer, the smell grows stronger.
Choose one direction.
Return only JSON: {"move":"down-right|down|stay|right"}.
```

