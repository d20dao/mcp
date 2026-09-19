import { describe, expect, it } from 'vitest';
import { buildDrawBody, checkSize, InputError, type DrawInput } from '../src/request.js';

const ok = (input: DrawInput) => buildDrawBody(input);
const bad = (input: DrawInput, field: string) => {
  expect(() => buildDrawBody(input)).toThrow(InputError);
  try {
    buildDrawBody(input);
  } catch (error) {
    expect((error as InputError).field).toBe(field);
  }
};

describe('buildDrawBody', () => {
  it('sends only the fields an operation takes, plus a non-empty seed', () => {
    expect(ok({ operation: 'dice', sides: 20, count: 2, seed: 'game-42' })).toEqual({ operation: 'dice', sides: 20, count: 2, seed: 'game-42' });
    expect(ok({ operation: 'coinFlip', seed: '' })).toEqual({ operation: 'coinFlip' });
    expect(ok({ operation: 'range', min: '0', max: '115792089237316195423570985008687907853269984665640564039457584007913129639935' })).toMatchObject({ operation: 'range' });
    expect(ok({ operation: 'chooseMany', items: ['a', 'b', 'c'], count: 2 })).toEqual({ operation: 'chooseMany', items: ['a', 'b', 'c'], count: 2 });
    expect(ok({ operation: 'shuffle', population: 52 })).toEqual({ operation: 'shuffle', population: 52 });
  });

  it('rejects fields another operation owns', () => {
    bad({ operation: 'coinFlip', sides: 2 }, 'sides');
    bad({ operation: 'raw', count: 1 }, 'count');
    bad({ operation: 'shuffle', population: 3, count: 3 }, 'count');
  });

  it('applies the API limits', () => {
    bad({ operation: 'dice' }, 'sides');
    bad({ operation: 'dice', sides: 1 }, 'sides');
    bad({ operation: 'dice', sides: 6, count: 129 }, 'count');
    bad({ operation: 'dice', sides: '01' }, 'sides');
    bad({ operation: 'range', min: 5 }, 'max');
    bad({ operation: 'range', min: 9, max: 3 }, 'min');
    bad({ operation: 'range', min: 0, max: (1n << 256n).toString() }, 'max');
    bad({ operation: 'chooseOne' }, 'population');
    bad({ operation: 'chooseOne', population: 3, items: ['a'] }, 'population');
    bad({ operation: 'chooseOne', population: 257 }, 'population');
    bad({ operation: 'chooseOne', items: ['x'.repeat(201)] }, 'items');
    bad({ operation: 'chooseMany', population: 3 }, 'count');
    bad({ operation: 'chooseMany', population: 3, count: 4 }, 'count');
    bad({ operation: 'raw', seed: 'ş'.repeat(33) }, 'seed');
  });

  it('refuses bodies the API or the Windows command line cannot take', () => {
    const quotes = Array.from({ length: 256 }, () => '"'.repeat(200));
    expect(() => checkSize(JSON.stringify({ operation: 'shuffle', items: quotes }), 'linux')).toThrow(/too large/);
    const plain = Array.from({ length: 256 }, (_, i) => `item-${i}`.padEnd(150, 'x'));
    expect(() => checkSize(JSON.stringify({ operation: 'shuffle', items: plain }), 'linux')).not.toThrow();
    expect(() => checkSize(JSON.stringify({ operation: 'shuffle', items: plain }), 'win32')).toThrow(/Windows/);
    expect(() => checkSize(JSON.stringify({ operation: 'shuffle', population: 256 }), 'win32')).not.toThrow();
  });
});
