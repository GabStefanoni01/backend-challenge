import Decimal from 'decimal.js';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Immutable monetary value. Amounts are represented as decimal strings at boundaries. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!/^-?(?:0|[1-9]\d*)\.\d{2}$/.test(props.amount)) {
      throw new MoneyError('Amount must be a decimal string with exactly two fractional digits');
    }
    if (!/^[A-Z]{3}$/.test(props.currency)) {
      throw new MoneyError('Currency must be a three-letter ISO-4217 code');
    }

    const value = new Decimal(props.amount);
    if (!value.isFinite()) {
      throw new MoneyError('Amount must be finite');
    }

    return new Money(value.isZero() ? new Decimal(0) : value, props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(`Currency mismatch: ${this.currency} and ${other.currency}`);
    }
  }
}
