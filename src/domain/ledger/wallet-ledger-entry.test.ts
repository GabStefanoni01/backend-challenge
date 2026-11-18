import { describe, expect, it } from 'bun:test';
import { Money } from '../shared/money';
import { WalletLedgerEntry, WalletLedgerEntryError } from './wallet-ledger-entry';

const money = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('WalletLedgerEntry', () => {
  it('validates a debit and credit record', () => {
    const debit = WalletLedgerEntry.create({ id: 'l1', walletId: 'w1', transactionId: 't1', direction: 'DEBIT', money: money('20.00'), balanceBefore: money('100.00'), balanceAfter: money('80.00') });
    expect(debit.isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ id: 'l2', walletId: 'w1', transactionId: 't2', direction: 'CREDIT', money: money('20.00'), balanceBefore: money('80.00'), balanceAfter: money('100.00') })).not.toThrow();
  });

  it('rejects unbalanced entries and negative resulting balances', () => {
    expect(() => WalletLedgerEntry.create({ id: 'l1', walletId: 'w1', transactionId: 't1', direction: 'DEBIT', money: money('20.00'), balanceBefore: money('100.00'), balanceAfter: money('90.00') })).toThrow(WalletLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ id: 'l2', walletId: 'w1', transactionId: 't2', direction: 'DEBIT', money: money('20.00'), balanceBefore: money('10.00'), balanceAfter: money('-10.00') })).toThrow(WalletLedgerEntryError);
  });
});
