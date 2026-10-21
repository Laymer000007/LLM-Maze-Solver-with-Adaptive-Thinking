# Laya Numerical Decision Investigation

- Timestamp: 2026-10-17T10:19:15.399Z
- Endpoint: http://192.168.88.100:8000/v1/systemone
- Frozen crossover states: 100
- Synthetic numerical cases: 21
- Credentials: not stored

## 1. Explanation of the 59% vs 29% discrepancy

The historical constrained request omitted the model field and embedded score/visit information in choice criteria. The prompt-format request sent model english, put scores in the state prompt, and supplied generic criteria. The same-state crossover below isolates this payload difference.

| Variant | Accuracy | Mean latency |
|---|---:|---:|
| original-constrained | 59.0% | 374 ms |
| original-constrained-english | 59.0% | 371 ms |
| numbers-english-frozen | 26.0% | 252 ms |
| numbers-default-frozen | 26.0% | 253 ms |

Correction for the full-size reproduction: the 100-state crossover measured 59.0% constrained versus 26.0% numbers-only; the earlier 20-state pilot was 55% versus 15%.

The constrained representation is the strongest measured explanation. Adding or omitting model english made no difference in this crossover. The historical 59% and new 29% results are therefore primarily a prompt/API representation difference, not a scoring or evaluation mismatch.

## 2. Reproduction and comparability

Both experiments used the same 100 frozen states, production-derived scores, legal actions, tie handling, and optimal-action evaluation. The historical benchmark used one request per state; the prompt-format benchmark used three repetitions per state and format. Historical full results were 59% constrained and 29% numbers-only. The controlled 20-state crossover reproduced the direction: 55% constrained versus 15% numbers-only.

Historical constrained request shape:

```json
{"state":{"body":"...legal choices... UP: score=-10; ... DOWN: score=10 ..."},"questions":{"move":{"type":"choice","criteria":{"UP":"up movement; score -10","DOWN":"down movement; score 10"}}}}
```

Numbers-only request shape:

```json
{"state":{"body":"... UP: -10 ... DOWN: 10 ..."},"model":"english","questions":{"move":{"type":"choice","criteria":{"UP":"up movement","DOWN":"down movement"}}}}
```

## 3. Score representation accuracy

| Variant | Accuracy | Mean latency |
|---|---:|---:|
| numbers-english | 33.3% | 219 ms |
| numbers-default | 33.3% | 214 ms |
| numbers-criteria | 28.6% | 248 ms |
| score-description | 33.3% | 235 ms |
| natural-language | 33.3% | 255 ms |
| structured | 28.6% | 244 ms |

These synthetic controls were exploratory one-shot cases. No representation reliably performed numerical maximization across all cases.

## 4. Option ordering and positional bias

- numbers-english: 1/4 correct; selected up, right, left, down
- score-description: 2/4 correct; selected up, right, up, right
- natural-language: 2/4 correct; selected up, right, up, right
- structured: 1/4 correct; selected up, right, left, down

The fixed-label controls repeatedly selected the first semantic label. This supports positional/label bias, although the small order sample cannot cleanly separate first-position from direction semantics.

## 5. Score reversal and numerical magnitude

Laya changed its answer correctly for some reversals, but often retained UP when the highest score moved elsewhere. Positive, negative, zero, decimal, small-gap, and large-gap cases were not consistently ranked. This is heuristic behavior rather than reliable numerical comparison.

## 6. Direction-name bias

Neutral labels and OPTION_n labels did not improve the controls; the first label was still selected. Direction semantics may contribute, but this run cannot fully separate them from position bias.

## 7. Error analysis

- state-001 / numbers-english-frozen: scores={"UP":-10,"DOWN":10}, expected=down, selected=up, latency=231 ms.
- state-001 / numbers-default-frozen: scores={"UP":-10,"DOWN":10}, expected=down, selected=up, latency=228 ms.
- state-002 / numbers-english-frozen: scores={"LEFT":-12,"RIGHT":12}, expected=right, selected=left, latency=229 ms.
- state-002 / numbers-default-frozen: scores={"LEFT":-12,"RIGHT":12}, expected=right, selected=left, latency=251 ms.
- state-003 / numbers-english-frozen: scores={"UP":-138,"DOWN":-6}, expected=down, selected=up, latency=229 ms.
- state-003 / numbers-default-frozen: scores={"UP":-138,"DOWN":-6}, expected=down, selected=up, latency=229 ms.
- state-004 / numbers-english-frozen: scores={"UP":-10,"DOWN":8}, expected=down, selected=up, latency=231 ms.
- state-004 / numbers-default-frozen: scores={"UP":-10,"DOWN":8}, expected=down, selected=up, latency=231 ms.
- state-005 / numbers-english-frozen: scores={"LEFT":-10,"RIGHT":12}, expected=right, selected=left, latency=227 ms.
- state-005 / numbers-default-frozen: scores={"LEFT":-10,"RIGHT":12}, expected=right, selected=left, latency=235 ms.

## 8. Recommended Laya prompt construction

Use legal movement identifiers in the supported choice API and put each numerical score directly in its criterion description, while also repeating a concise legal-choice list in the state prompt. Do not encode scores into identifiers or rely on the model to infer legality from all four directions.

## 9. Limitations and remaining questions

The synthetic set is small and mostly one-shot; it diagnoses failure modes but is not a population estimate. The checkpoint used when model is omitted is not named in response metadata. Internal routing or hidden context may remain. No production code, checkpoint, or historical result was modified.

No production Maze Solver, scoring algorithm, Laya integration, or existing benchmark result was modified.
