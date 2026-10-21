import { describe, expect, it } from 'vitest';
import { expected, makeNumericalCases } from './laya-numerical-investigation';

describe('Laya numerical investigation controls', () => {
  it('selects every tied maximum as correct', () => {
    expect(expected({ UP: 0, DOWN: 0, LEFT: -1 }, ['UP', 'DOWN', 'LEFT'])).toEqual(['UP', 'DOWN']);
  });

  it('includes reversal, negative, decimal, order, and tie controls', () => {
    const families = new Set(makeNumericalCases().map((test) => test.family));
    expect(families).toEqual(new Set(['positive-negative-2', 'positive-3', 'reversal-1', 'reversal-2', 'reversal-3', 'reversal-4', 'scale-small', 'scale-medium', 'scale-large', 'scale-negative', 'scale-decimal', 'tie-maximum', 'small-difference', 'large-gap']));
  });
});
