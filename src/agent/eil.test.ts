import { describe, expect, it } from 'vitest';
import { EiL } from '@/agent/eil';
describe('Sensor-driven EiL',()=>{it('starts at 500 and clamps to 0..1000',()=>{const e=new EiL();expect(e.snapshot().score).toBe(500);expect(e.apply(-9999).score).toBe(0);expect(e.apply(9999).score).toBe(1000);});});
