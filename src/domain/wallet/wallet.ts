import { Money } from '../shared/money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BalanceMovement {
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
}

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

export class InsufficientFundsError extends WalletError {
  constructor() {
    super('Wallet has insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at?: Date }): Wallet {
    if (!props.id || !props.playerId) throw new WalletError('Wallet id and playerId are required');
    if (props.initialBalance.isNegative()) throw new WalletError('Initial balance cannot be negative');
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at ?? new Date(),
      props.at ?? new Date(),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  debit(amount: Money, at: Date = new Date()): BalanceMovement {
    this.assertPositiveAmount(amount);
    if (this._balance.isLessThan(amount)) throw new InsufficientFundsError();
    return this.apply('DEBIT', amount, this._balance.subtract(amount), at);
  }

  credit(amount: Money, at: Date = new Date()): BalanceMovement {
    this.assertPositiveAmount(amount);
    return this.apply('CREDIT', amount, this._balance.add(amount), at);
  }

  private apply(direction: LedgerDirection, amount: Money, nextBalance: Money, at: Date): BalanceMovement {
    const before = this._balance;
    this._balance = nextBalance;
    this._version += 1;
    this._updatedAt = at;
    return {
      direction,
      amount,
      balanceBefore: before,
      balanceAfter: nextBalance,
      walletVersion: this._version,
    };
  }

  private assertPositiveAmount(amount: Money): void {
    if (amount.currency !== this.currency) throw new WalletError('Wallet currency mismatch');
    if (!amount.isPositive()) throw new WalletError('Movement amount must be positive');
  }
}
