import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60_000);
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { WalletEntity } from '../database/entities/wallet.entity';
import { WalletsService } from '../wallets/wallets.service';
import { CreateWagerTransactionDto } from './dto/create-wager-transaction.dto';
import { WageringService } from './wagering.service';

describe('WageringService PostgreSQL concurrency', () => {
  let orm: MikroORM;
  let wallets: WalletsService;
  let wagering: WageringService;

  beforeAll(async () => {
    const clientUrl = process.env.DATABASE_URL;
    if (!clientUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl,
      entities: [WalletEntity],
      allowGlobalContext: true,
      pool: { min: 2, max: 20, acquireTimeoutMillis: 60_000 },
    });
    wallets = new WalletsService(orm);
    wagering = new WageringService(orm);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it('deduplicates the same wager submitted 50 times concurrently', async () => {
    const suffix = randomUUID();
    const wallet = await wallets.create({
      playerId: `player-${suffix}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const payload: CreateWagerTransactionDto = {
      providerId: 'provider-concurrency',
      externalTransactionId: `external-${suffix}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${suffix}`,
      gameId: 'concurrency-test',
      kind: 'BET' as CreateWagerTransactionDto['kind'],
      money: { amount: '10.00', currency: 'BRL' },
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => wagering.submit(payload, `key-${suffix}`)),
    );

    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(50);
    expect(results.filter((result) => result.idempotentReplay === false)).toHaveLength(1);

    const rows = await orm.em.getConnection().execute(
      'select balance from wallets where id = ?',
      [wallet.id],
    ) as Array<{ balance: string }>;
    expect(rows[0]?.balance).toBe('90.00');

    const ledgerRows = await orm.em.getConnection().execute(
      `select count(*)::int as total from wallet_ledger_entries
       where wallet_id = ? and transaction_id in
       (select id from wager_transactions where provider_id = ? and external_transaction_id = ? and kind = 'BET')`,
      [wallet.id, payload.providerId, payload.externalTransactionId],
    ) as Array<{ total: number }>;
    expect(ledgerRows[0]?.total).toBe(1);
  });

  it('allows only one of two concurrent 80.00 bets against a 100.00 balance', async () => {
    const suffix = randomUUID();
    const wallet = await wallets.create({
      playerId: `player-${suffix}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const createPayload = (externalTransactionId: string): CreateWagerTransactionDto => ({
      providerId: 'provider-hot-wallet',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${suffix}`,
      gameId: 'hot-wallet-test',
      kind: 'BET' as CreateWagerTransactionDto['kind'],
      money: { amount: '80.00', currency: 'BRL' },
    });

    const results = await Promise.all([
      wagering.submit(createPayload(`bet-a-${suffix}`), `key-a-${suffix}`),
      wagering.submit(createPayload(`bet-b-${suffix}`), `key-b-${suffix}`),
    ]);

    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'REJECTED')).toHaveLength(1);

    const rows = await orm.em.getConnection().execute(
      'select balance from wallets where id = ?',
      [wallet.id],
    ) as Array<{ balance: string }>;
    expect(rows[0]?.balance).toBe('20.00');

    const ledgerRows = await orm.em.getConnection().execute(
      `select count(*)::int as total from wallet_ledger_entries
       where wallet_id = ? and direction = 'DEBIT'
       and transaction_id in (select id from wager_transactions where kind = 'BET' and round_id = ?)`,
      [wallet.id, `round-${suffix}`],
    ) as Array<{ total: number }>;
    expect(ledgerRows[0]?.total).toBe(1);
  });
});
