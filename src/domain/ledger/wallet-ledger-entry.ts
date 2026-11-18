import { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/wallet';

export interface WalletLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt?: Date;
}

export class WalletLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletLedgerEntryError';
  }
}

/** Immutable audit record. Updates and deletes are also blocked by a database trigger. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id, props.walletId, props.transactionId, props.direction,
      props.money, props.balanceBefore, props.balanceAfter, props.createdAt ?? new Date(),
    );
    if (!entry.isBalanced()) throw new WalletLedgerEntryError('Ledger entry does not balance');
    if (!props.money.isPositive()) throw new WalletLedgerEntryError('Ledger amount must be positive');
    if (props.balanceAfter.isNegative()) throw new WalletLedgerEntryError('Ledger result cannot be negative');
    return entry;
  }

  static rehydrate(state: WalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id, state.walletId, state.transactionId, state.direction,
      state.money, state.balanceBefore, state.balanceAfter, state.createdAt ?? new Date(),
    );
  }

  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) return false;
    const expected = this.direction === 'CREDIT'
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
