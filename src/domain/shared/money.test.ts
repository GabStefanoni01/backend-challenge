import { describe, expect, it } from 'bun:test';
import { Money, MoneyError } from './money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  it('adds and subtracts without floating-point precision loss', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('10.00').subtract(brl('0.10')).toString()).toBe('9.90');
  });

  it('is immutable and supports negation', () => {
    const original = brl('12.50');
    expect(original.negate().toString()).toBe('-12.50');
    expect(original.toString()).toBe('12.50');
  });

  it('normalizes zero and compares values', () => {
    expect(brl('-0.00').toString()).toBe('0.00');
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
  });

  it.each(['', '1', '1.0', '1.000', '01.00', '1e2', 'NaN', 'Infinity']) (
    'rejects invalid decimal input: %s',
    (amount) => {
      expect(() => brl(amount)).toThrow(MoneyError);
    },
  );

  it('rejects invalid currency and mixed-currency arithmetic', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(MoneyError);
    expect(() => brl('1.00').add(Money.from({ amount: '1.00', currency: 'USD' }))).toThrow(MoneyError);
  });
});
