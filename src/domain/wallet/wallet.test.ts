import { describe, expect, it } from 'bun:test';
import { Money } from '../shared/money';
import { InsufficientFundsError, Wallet, WalletError } from './wallet';

const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

describe('Wallet', () => {
  it('opens with version one and the requested balance', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00') });
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('debits and credits while incrementing the version only on movements', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00') });
    const debit = wallet.debit(money('30.00'));
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);

    wallet.credit(money('5.00'));
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(3);
  });

  it('does not allow a negative balance', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('50.00') });
    expect(() => wallet.debit(money('80.00'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects negative opening balance, zero movements and currency mismatch', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('-1.00') })).toThrow(WalletError);
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00') });
    expect(() => wallet.credit(money('0.00'))).toThrow(WalletError);
    expect(() => wallet.debit(money('1.00', 'USD'))).toThrow(WalletError);
  });
});
