import { createHash, randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { Money } from '../domain/shared/money';
import { Wallet } from '../domain/wallet/wallet';
import { CreateWalletDto } from './dto/create-wallet.dto';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class WalletsService {
  constructor(private readonly orm: MikroORM) {}

  async create(input: CreateWalletDto) {
    const initialBalance = Money.from(input.initialBalance);
    const walletId = randomUUID();
    const now = new Date();
    const wallet = Wallet.open({ id: walletId, playerId: input.playerId, initialBalance, at: now });

    try {
      await this.orm.em.transactional(async (em) => {
        const connection = em.getConnection();
        await connection.execute(
          'insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
          [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toString(), wallet.version, now, now],
        );

        if (initialBalance.isPositive()) {
          const transactionId = randomUUID();
          const payloadHash = createHash('sha256')
            .update(JSON.stringify({ walletId, playerId: input.playerId, kind: 'OPENING', money: initialBalance.toJSON() }))
            .digest('hex');
          const ledger = WalletLedgerEntry.create({
            id: randomUUID(), walletId, transactionId, direction: 'CREDIT',
            money: initialBalance, balanceBefore: Money.zero(initialBalance.currency),
            balanceAfter: initialBalance, createdAt: now,
          });

          await connection.execute(
            `insert into wager_transactions
              (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, created_at)
             values (?, 'internal', ?, ?, ?, ?, ?, 'internal', 'internal', 'OPENING', ?, ?, 'PROCESSED', ?, ?)`,
            [transactionId, `opening:${walletId}`, `opening:${walletId}`, payloadHash, walletId, input.playerId, initialBalance.toString(), initialBalance.currency, now, now],
          );
          await connection.execute(
            `insert into wallet_ledger_entries
              (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ledger.id, ledger.walletId, ledger.transactionId, ledger.direction, ledger.money.toString(), ledger.money.currency, ledger.balanceBefore.toString(), ledger.balanceAfter.toString(), ledger.createdAt],
          );

          const balanceEvent = {
            eventId: randomUUID(), eventType: 'WalletBalanceChanged', aggregateId: walletId,
            correlationId: transactionId, occurredAt: now.toISOString(), version: 1,
            data: {
              walletId, transactionId, direction: 'CREDIT', money: initialBalance.toJSON(),
              balanceBefore: ledger.balanceBefore.toJSON(), balanceAfter: ledger.balanceAfter.toJSON(),
              walletVersion: wallet.version,
            },
          };
          const processedEvent = {
            eventId: randomUUID(), eventType: 'WagerTransactionProcessed', aggregateId: transactionId,
            correlationId: transactionId, occurredAt: now.toISOString(), version: 1,
            data: { transactionId, walletId, kind: 'OPENING', status: 'PROCESSED' },
          };
          for (const event of [balanceEvent, processedEvent]) {
            await connection.execute(
              'insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at) values (?, ?, ?, ?::jsonb, ?)',
              [event.eventId, event.aggregateId, event.eventType, JSON.stringify(event), now],
            );
          }
        }
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new ConflictException('A wallet already exists for this player and currency');
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  async findById(walletId: string) {
    const rows = await this.orm.em.getConnection().execute(
      'select id, player_id, currency, balance, version, created_at, updated_at from wallets where id = ?',
      [walletId],
    ) as WalletRow[];
    const wallet = rows[0];
    if (!wallet) throw new NotFoundException('Wallet not found');

    return {
      id: wallet.id,
      playerId: wallet.player_id,
      balance: { amount: wallet.balance, currency: wallet.currency.trim() },
      version: wallet.version,
      createdAt: wallet.created_at,
      updatedAt: wallet.updated_at,
    };
  }
}
