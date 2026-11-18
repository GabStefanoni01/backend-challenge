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

export interface InboxContext { consumerName: string; messageId: string; payloadHash: string; }

export type WagerResponse = {
  duplicateMessage?: boolean;
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

  async submit(input: CreateWagerTransactionDto, idempotencyKey: string, inbox?: InboxContext): Promise<WagerResponse> {
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
        if (prior[0]) {
          if (inbox) {
            await connection.execute(
              'update inbox_messages set processed_at = now() where consumer_name = ? and message_id = ?',
              [inbox.consumerName, inbox.messageId],
            );
          }
          return this.replay(prior[0], payloadHash);
        }

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
        if (lockedPrior[0]) {
          if (inbox) {
            await connection.execute(
              'update inbox_messages set processed_at = now() where consumer_name = ? and message_id = ?',
              [inbox.consumerName, inbox.messageId],
            );
          }
          return this.replay(lockedPrior[0], payloadHash);
        }

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


  async processPendingReferences(batchSize = 25): Promise<{ resolved: number; stillPending: number }> {
    const candidates = await this.orm.em.getConnection().execute(
      `select id from wager_transactions
       where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= now()
       order by next_reference_attempt_at, created_at
       limit ?`,
      [Math.min(Math.max(batchSize, 1), 100)],
    ) as Array<{ id: string }>;

    let resolved = 0;
    let stillPending = 0;

    for (const candidate of candidates) {
      const outcome = await this.orm.em.transactional(async (em) => {
        const connection = em.getConnection();
        const pendingRows = await connection.execute(
          `select id, provider_id, external_transaction_id, wallet_id, player_id, round_id,
                  game_id, kind, amount, currency, reference_external_transaction_id,
                  reference_attempts, reference_expires_at
           from wager_transactions
           where id = ? and status = 'PENDING_REFERENCE'
             and next_reference_attempt_at <= now()
           for update skip locked`,
          [candidate.id],
        ) as Array<{
          id: string; provider_id: string; external_transaction_id: string;
          wallet_id: string; player_id: string; round_id: string; game_id: string;
          kind: string; amount: string; currency: string;
          reference_external_transaction_id: string; reference_attempts: number;
          reference_expires_at: Date;
        }>;
        const pending = pendingRows[0];
        if (!pending) return 'skipped' as const;

        const walletRows = await connection.execute(
          `select id, player_id, currency, balance, version, created_at, updated_at
           from wallets where id = ? for update`,
          [pending.wallet_id],
        ) as WalletRow[];
        const walletRow = walletRows[0];
        const now = new Date();

        if (!walletRow) {
          await this.rejectPending(connection, pending, undefined, 'WALLET_NOT_FOUND', now);
          return 'resolved' as const;
        }

        const referenceRows = await connection.execute(
          `select id, provider_id, player_id, wallet_id, round_id, kind, status, amount, currency
           from wager_transactions where provider_id = ? and external_transaction_id = ?`,
          [pending.provider_id, pending.reference_external_transaction_id],
        ) as ReferenceRow[];
        const reference = referenceRows[0];

        if (!reference) {
          const attempts = pending.reference_attempts + 1;
          const expired = new Date(pending.reference_expires_at).getTime() <= now.getTime();
          if (expired || attempts >= 12) {
            await this.rejectPending(connection, pending, walletRow, 'REFERENCE_NOT_FOUND', now, attempts);
            return 'resolved' as const;
          }

          const delaySeconds = Math.min(300, 5 * (2 ** Math.min(attempts - 1, 6)));
          await connection.execute(
            `update wager_transactions
             set reference_attempts = ?,
                 next_reference_attempt_at = now() + make_interval(secs => ?)
             where id = ? and status = 'PENDING_REFERENCE'`,
            [attempts, delaySeconds, pending.id],
          );
          return 'pending' as const;
        }

        let failureCode: string | undefined;
        if (
          reference.player_id !== pending.player_id ||
          reference.wallet_id !== pending.wallet_id ||
          reference.round_id !== pending.round_id ||
          reference.currency.trim() !== pending.currency.trim() ||
          reference.provider_id !== pending.provider_id ||
          reference.status !== 'PROCESSED'
        ) {
          failureCode = 'REFERENCE_INVALID';
        } else if (pending.kind === 'REFUND' && reference.kind !== 'BET') {
          failureCode = 'REFERENCE_INVALID';
        } else if (pending.kind === 'ROLLBACK' && !['BET', 'WIN', 'REFUND'].includes(reference.kind)) {
          failureCode = 'REFERENCE_INVALID';
        } else if (pending.kind === 'WIN' && reference.kind !== 'BET') {
          failureCode = 'REFERENCE_INVALID';
        } else if (pending.kind !== 'WIN' && reference.amount !== pending.amount) {
          failureCode = 'REFERENCE_INVALID';
        }

        if (!failureCode && ['REFUND', 'ROLLBACK'].includes(pending.kind)) {
          const duplicateRows = await connection.execute(
            'select id from wager_transactions where reference_transaction_id = ? and kind = ? and id <> ?',
            [reference.id, pending.kind, pending.id],
          ) as Array<{ id: string }>;
          if (duplicateRows.length > 0) failureCode = 'DUPLICATE_REVERSAL';
        }

        if (failureCode) {
          await this.rejectPending(connection, pending, walletRow, failureCode, now, pending.reference_attempts, reference.id);
          return 'resolved' as const;
        }

        const money = Money.from({ amount: pending.amount, currency: pending.currency.trim() });
        const wallet = Wallet.rehydrate({
          id: walletRow.id,
          playerId: walletRow.player_id,
          currency: walletRow.currency.trim(),
          balance: Money.from({ amount: walletRow.balance, currency: walletRow.currency.trim() }),
          version: walletRow.version,
          createdAt: walletRow.created_at,
          updatedAt: walletRow.updated_at,
        });

        let movement: ReturnType<Wallet['debit']> | undefined;
        let direction: 'DEBIT' | 'CREDIT' | undefined;
        try {
          if (pending.kind === 'WIN' || pending.kind === 'REFUND') {
            movement = wallet.credit(money, now);
            direction = 'CREDIT';
          } else if (pending.kind === 'ROLLBACK') {
            const reverseDebit = reference.kind === 'BET';
            movement = reverseDebit ? wallet.credit(money, now) : wallet.debit(money, now);
            direction = reverseDebit ? 'CREDIT' : 'DEBIT';
          }
        } catch (error) {
          if (error instanceof InsufficientFundsError) {
            await this.rejectPending(connection, pending, walletRow, 'REVERSAL_WOULD_OVERDRAW', now, pending.reference_attempts, reference.id);
            return 'resolved' as const;
          }
          throw error;
        }

        if (movement && direction) {
          await connection.execute(
            'update wallets set balance = ?, version = ?, updated_at = ? where id = ?',
            [movement.balanceAfter.toString(), wallet.version, now, walletRow.id],
          );
          await connection.execute(
            `insert into wallet_ledger_entries
              (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [randomUUID(), walletRow.id, pending.id, direction, money.toString(), money.currency,
              movement.balanceBefore.toString(), movement.balanceAfter.toString(), now],
          );
        }

        const resultingBalance = movement?.balanceAfter ?? Money.from({ amount: walletRow.balance, currency: walletRow.currency.trim() });
        await connection.execute(
          `update wager_transactions
           set status = 'PROCESSED', reference_transaction_id = ?, reference_attempts = ?,
               result_balance = ?, result_version = ?, processed_at = ?
           where id = ? and status = 'PENDING_REFERENCE'`,
          [reference.id, pending.reference_attempts, resultingBalance.toString(), wallet.version, now, pending.id],
        );
        await this.enqueue(connection, 'WagerTransactionProcessed', pending.id, {
          transactionId: pending.id, providerId: pending.provider_id,
          externalTransactionId: pending.external_transaction_id, walletId: pending.wallet_id,
          kind: pending.kind, status: 'PROCESSED',
        }, now);
        if (movement && direction) {
          await this.enqueue(connection, 'WalletBalanceChanged', walletRow.id, {
            walletId: walletRow.id, transactionId: pending.id, direction,
            money: money.toJSON(), balanceBefore: movement.balanceBefore.toJSON(),
            balanceAfter: movement.balanceAfter.toJSON(), walletVersion: wallet.version,
          }, now);
        }
        return 'resolved' as const;
      });

      if (outcome === 'resolved') resolved += 1;
      if (outcome === 'pending') stillPending += 1;
    }

    return { resolved, stillPending };
  }

  private async rejectPending(
    connection: ReturnType<EntityManager['getConnection']>,
    pending: { id: string; provider_id: string; external_transaction_id: string; wallet_id: string; kind: string; reference_attempts: number },
    wallet: WalletRow | undefined,
    failureCode: string,
    now: Date,
    attempts = pending.reference_attempts,
    referenceId?: string,
  ): Promise<void> {
    const balance = wallet?.balance ?? '0.00';
    const currency = wallet?.currency.trim() ?? 'BRL';
    const version = wallet?.version ?? 1;
    await connection.execute(
      `update wager_transactions
       set status = 'REJECTED', failure_code = ?, reference_transaction_id = ?,
           reference_attempts = ?, result_balance = ?, result_version = ?, processed_at = ?
       where id = ? and status = 'PENDING_REFERENCE'`,
      [failureCode, referenceId ?? null, attempts, balance, version, now, pending.id],
    );
    await this.enqueue(connection, 'WagerTransactionRejected', pending.id, {
      transactionId: pending.id, externalTransactionId: pending.external_transaction_id,
      walletId: pending.wallet_id, kind: pending.kind, status: 'REJECTED', failureCode,
    }, now);
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
