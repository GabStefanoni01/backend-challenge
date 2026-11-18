import { createHash, randomUUID } from 'node:crypto';
import { EntityManager, MikroORM } from '@mikro-orm/core';
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InsufficientFundsError, Wallet } from '../domain/wallet/wallet';
import { Money } from '../domain/shared/money';
import { CreateWagerTransactionDto, PublicWagerKind } from './dto/create-wager-transaction.dto';

interface WalletRow {
  id: string; player_id: string; currency: string; balance: string;
  version: number; created_at: Date; updated_at: Date;
}
interface TransactionRow {
  id: string; payload_hash: string; status: string; result_balance: string | null;
  result_version: number | null; failure_code: string | null; currency: string;
}
interface ReferenceRow {
  id: string; provider_id: string; player_id: string; wallet_id: string;
  round_id: string; kind: string; status: string; amount: string; currency: string;
}

type WagerResponse = {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

@Injectable()
export class WageringService {
  constructor(private readonly orm: MikroORM) {}

  async submit(input: CreateWagerTransactionDto, idempotencyKey: string): Promise<WagerResponse> {
    if (!idempotencyKey || idempotencyKey.length > 256) {
      throw new UnprocessableEntityException('Idempotency-Key header is required and must be at most 256 characters');
    }

    const money = Money.from(input.money);
    if (!money.isPositive()) throw new UnprocessableEntityException('Transaction amount must be greater than zero');
    if ((input.kind === PublicWagerKind.Refund || input.kind === PublicWagerKind.Rollback) && !input.referenceExternalTransactionId) {
      throw new UnprocessableEntityException('REFUND and ROLLBACK require referenceExternalTransactionId');
    }

    const businessPayload = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    };
    const payloadHash = createHash('sha256').update(stableJson(businessPayload)).digest('hex');

    try {
      return await this.orm.em.transactional(async (em) => {
        const connection = em.getConnection();

        const prior = await connection.execute(
          'select id, payload_hash, status, result_balance, result_version, failure_code, currency from wager_transactions where provider_id = ? and idempotency_key = ?',
          [input.providerId, idempotencyKey],
        ) as TransactionRow[];
        if (prior[0]) return this.replay(prior[0], payloadHash);

        const walletRows = await connection.execute(
          'select id, player_id, currency, balance, version, created_at, updated_at from wallets where id = ? for update',
          [input.walletId],
        ) as WalletRow[];
        const walletRow = walletRows[0];
        if (!walletRow) throw new NotFoundException('Wallet not found');
        if (walletRow.player_id !== input.playerId) {
          throw new UnprocessableEntityException('Wallet does not belong to the supplied player');
        }
        if (walletRow.currency.trim() !== money.currency) {
          throw new UnprocessableEntityException('Wallet and transaction currencies do not match');
        }

        // Recheck after acquiring the wallet lock: concurrent requests for this wallet serialize here.
        const lockedPrior = await connection.execute(
          'select id, payload_hash, status, result_balance, result_version, failure_code, currency from wager_transactions where provider_id = ? and idempotency_key = ?',
          [input.providerId, idempotencyKey],
        ) as TransactionRow[];
        if (lockedPrior[0]) return this.replay(lockedPrior[0], payloadHash);

        const externalPrior = await connection.execute(
          'select id from wager_transactions where provider_id = ? and external_transaction_id = ?',
          [input.providerId, input.externalTransactionId],
        ) as Array<{ id: string }>;
        if (externalPrior[0]) throw new ConflictException('Provider transaction already exists with a different idempotency key');

        const transactionId = randomUUID();
        const now = new Date();
        let status = 'PROCESSED';
        let failureCode: string | undefined;
        let reference: ReferenceRow | undefined;
        let direction: 'DEBIT' | 'CREDIT' | undefined;
        let movement: ReturnType<Wallet['debit']> | undefined;
        let resultBalance = Money.from({ amount: walletRow.balance, currency: money.currency });
        let resultVersion = walletRow.version;

        if (input.kind === PublicWagerKind.Refund || input.kind === PublicWagerKind.Rollback ||
            (input.kind === PublicWagerKind.Win && input.referenceExternalTransactionId)) {
          const referenceRows = await connection.execute(
            'select id, provider_id, player_id, wallet_id, round_id, kind, status, amount, currency from wager_transactions where provider_id = ? and external_transaction_id = ?',
            [input.providerId, input.referenceExternalTransactionId],
          ) as ReferenceRow[];
          reference = referenceRows[0];
          if (!reference) {
            status = 'PENDING_REFERENCE';
          } else if (
            reference.player_id !== input.playerId || reference.wallet_id !== input.walletId ||
            reference.round_id !== input.roundId || reference.currency.trim() !== money.currency ||
            reference.provider_id !== input.providerId
          ) {
            status = 'REJECTED';
            failureCode = 'REFERENCE_INVALID';
          } else if (reference.status !== 'PROCESSED') {
            status = 'REJECTED';
            failureCode = 'REFERENCE_INVALID';
          } else if (input.kind === PublicWagerKind.Refund && reference.kind !== 'BET') {
            status = 'REJECTED';
            failureCode = 'REFERENCE_INVALID';
          } else if (input.kind === PublicWagerKind.Rollback && !['BET', 'WIN', 'REFUND'].includes(reference.kind)) {
            status = 'REJECTED';
            failureCode = 'REFERENCE_INVALID';
          } else if (input.kind === PublicWagerKind.Win && reference.kind !== 'BET') {
            status = 'REJECTED';
            failureCode = 'REFERENCE_INVALID';
          } else if (input.kind !== PublicWagerKind.Win && reference.amount !== money.toString()) {
            status = 'REJECTED';
            failureCode = 'REFERENCE_INVALID';
          } else {
            const duplicateReversal = await connection.execute(
              'select id from wager_transactions where reference_transaction_id = ? and kind = ?',
              [reference.id, input.kind],
            ) as Array<{ id: string }>;
            if (duplicateReversal[0]) {
              status = 'REJECTED';
              failureCode = 'DUPLICATE_REVERSAL';
            }
          }
        }

        if (status === 'PROCESSED') {
          const wallet = Wallet.rehydrate({
            id: walletRow.id, playerId: walletRow.player_id, currency: money.currency,
            balance: resultBalance, version: walletRow.version,
            createdAt: walletRow.created_at, updatedAt: walletRow.updated_at,
          });

          try {
            if (input.kind === PublicWagerKind.Bet) {
              movement = wallet.debit(money, now);
              direction = 'DEBIT';
            } else if (input.kind === PublicWagerKind.Win || input.kind === PublicWagerKind.Refund) {
              movement = wallet.credit(money, now);
              direction = 'CREDIT';
            } else if (input.kind === PublicWagerKind.Rollback) {
              const reverseDebit = reference?.kind === 'BET';
              movement = reverseDebit ? wallet.credit(money, now) : wallet.debit(money, now);
              direction = reverseDebit ? 'CREDIT' : 'DEBIT';
            }
            resultBalance = wallet.balance;
            resultVersion = wallet.version;
          } catch (error) {
            if (error instanceof InsufficientFundsError) {
              status = 'REJECTED';
              failureCode = input.kind === PublicWagerKind.Bet ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_WOULD_OVERDRAW';
            } else {
              throw error;
            }
          }
        }

        await connection.execute(
          `insert into wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code, result_balance, result_version, processed_at, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            transactionId, input.providerId, input.externalTransactionId, idempotencyKey, payloadHash,
            input.walletId, input.playerId, input.roundId, input.gameId, input.kind, money.toString(),
            money.currency, input.referenceExternalTransactionId ?? null, reference?.id ?? null,
            status, failureCode ?? null, resultBalance.toString(), resultVersion, status === 'PENDING_REFERENCE' ? null : now, now,
          ],
        );

        if (movement && direction) {
          await connection.execute(
            'update wallets set balance = ?, version = ?, updated_at = ? where id = ?',
            [movement.balanceAfter.toString(), resultVersion, now, input.walletId],
          );
          await connection.execute(
            `insert into wallet_ledger_entries
              (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [randomUUID(), input.walletId, transactionId, direction, money.toString(), money.currency,
              movement.balanceBefore.toString(), movement.balanceAfter.toString(), now],
          );
        }

        const eventType = status === 'PROCESSED'
          ? 'WagerTransactionProcessed'
          : status === 'PENDING_REFERENCE'
            ? 'WagerTransactionPendingReference'
            : 'WagerTransactionRejected';
        await this.enqueue(connection, eventType, transactionId, {
          transactionId, providerId: input.providerId, externalTransactionId: input.externalTransactionId,
          walletId: input.walletId, kind: input.kind, status, failureCode,
        }, now);

        if (movement && direction) {
          await this.enqueue(connection, 'WalletBalanceChanged', input.walletId, {
            walletId: input.walletId, transactionId, direction, money: money.toJSON(),
            balanceBefore: movement.balanceBefore.toJSON(), balanceAfter: movement.balanceAfter.toJSON(),
            walletVersion: resultVersion,
          }, now);
        }

        return {
          transactionId, status,
          balance: resultBalance.toJSON(),
          idempotentReplay: false,
          ...(failureCode ? { failureCode } : {}),
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const existing = await this.findByIdempotency(input.providerId, idempotencyKey);
        if (existing) return this.replay(existing, payloadHash);
        throw new ConflictException('Provider transaction already exists');
      }
      throw error;
    }
  }

  async findById(transactionId: string) {
    const rows = await this.orm.em.getConnection().execute(
      'select id, provider_id, external_transaction_id, wallet_id, kind, amount, currency, status, failure_code, result_balance, result_version, created_at, processed_at from wager_transactions where id = ?',
      [transactionId],
    ) as Array<Record<string, unknown>>;
    if (!rows[0]) throw new NotFoundException('Wager transaction not found');
    return rows[0];
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string) {
    const rows = await this.orm.em.getConnection().execute(
      'select id, provider_id, external_transaction_id, wallet_id, kind, amount, currency, status, failure_code, result_balance, result_version, created_at, processed_at from wager_transactions where provider_id = ? and external_transaction_id = ?',
      [providerId, externalTransactionId],
    ) as Array<Record<string, unknown>>;
    if (!rows[0]) throw new NotFoundException('Provider transaction not found');
    return rows[0];
  }

  private replay(row: TransactionRow, payloadHash: string): WagerResponse {
    if (row.payload_hash !== payloadHash) {
      throw new ConflictException('Idempotency-Key was already used with a different payload');
    }
    return {
      transactionId: row.id,
      status: row.status,
      balance: { amount: row.result_balance ?? '0.00', currency: row.currency.trim() },
      idempotentReplay: true,
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    };
  }

  private async findByIdempotency(providerId: string, key: string): Promise<TransactionRow | undefined> {
    const rows = await this.orm.em.getConnection().execute(
      'select id, payload_hash, status, result_balance, result_version, failure_code, currency from wager_transactions where provider_id = ? and idempotency_key = ?',
      [providerId, key],
    ) as TransactionRow[];
    return rows[0];
  }

  private async enqueue(connection: ReturnType<EntityManager['getConnection']>, eventType: string, aggregateId: string, data: Record<string, unknown>, now: Date): Promise<void> {
    const event = {
      eventId: randomUUID(), eventType, aggregateId, correlationId: aggregateId,
      occurredAt: now.toISOString(), version: 1, data,
    };
    await connection.execute(
      'insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at) values (?, ?, ?, ?::jsonb, ?)',
      [event.eventId, aggregateId, eventType, JSON.stringify(event), now],
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }
}
