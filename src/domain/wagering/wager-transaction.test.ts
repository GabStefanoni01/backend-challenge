import { describe, expect, it } from 'bun:test';
import { Money } from '../shared/money';
import { WagerTransaction, WagerTransactionError, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

const create = (kind = WagerTransactionKind.Bet, referenceExternalTransactionId?: string) => WagerTransaction.create({
  id: 'tx-1', providerId: 'provider-a', externalTransactionId: 'external-1',
  idempotencyKey: 'provider-a:external-1', payloadHash: 'a'.repeat(64),
  walletId: 'wallet-1', playerId: 'player-1', roundId: 'round-1', gameId: 'game-1',
  kind, money: Money.from({ amount: '10.00', currency: 'BRL' }), referenceExternalTransactionId,
});

describe('WagerTransaction', () => {
  it('starts pending and reaches a terminal processed state', () => {
    const tx = create();
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    tx.markProcessed();
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject('INSUFFICIENT_FUNDS')).toThrow(WagerTransactionError);
  });

  it('requires a reference for refund and rollback', () => {
    expect(() => create(WagerTransactionKind.Refund)).toThrow(WagerTransactionError);
    expect(() => create(WagerTransactionKind.Rollback)).toThrow(WagerTransactionError);
  });

  it('supports pending references and explicit rejection', () => {
    const tx = create(WagerTransactionKind.Refund, 'bet-external-1');
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    tx.reject('REFERENCE_NOT_FOUND');
    expect(tx.failureCode).toBe('REFERENCE_NOT_FOUND');
  });

  it('maps transaction kinds to ledger directions', () => {
    expect(create(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe('DEBIT');
    expect(create(WagerTransactionKind.Win).ledgerDirectionFor()).toBe('CREDIT');
    expect(create(WagerTransactionKind.Loss).ledgerDirectionFor()).toBeUndefined();
  });
});
