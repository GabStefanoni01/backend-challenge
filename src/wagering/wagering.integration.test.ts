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
  let otherOrms: MikroORM[] = [];

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
    otherOrms = await Promise.all(Array.from({ length: 2 }, () => MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl,
      entities: [WalletEntity],
      allowGlobalContext: true,
      pool: { min: 1, max: 10, acquireTimeoutMillis: 60_000 },
    })));
  });

  afterAll(async () => {
    await Promise.all(otherOrms.map((instance) => instance.close(true)));
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
  it('processes one hot wallet safely across three independent ORM instances', async () => {
    const suffix = randomUUID();
    const wallet = await wallets.create({
      playerId: `player-${suffix}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const services = [wagering, ...otherOrms.map((instance) => new WageringService(instance))];
    const results = await Promise.all(services.map((service, index) => service.submit({
      providerId: 'provider-multi-instance',
      externalTransactionId: `multi-${index}-${suffix}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${suffix}`,
      gameId: 'multi-instance-test',
      kind: 'BET' as CreateWagerTransactionDto['kind'],
      money: { amount: '80.00', currency: 'BRL' },
    }, `multi-key-${index}-${suffix}`)));

    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'REJECTED')).toHaveLength(2);
    const rows = await orm.em.getConnection().execute(
      'select balance from wallets where id = ?', [wallet.id],
    ) as Array<{ balance: string }>;
    expect(rows[0]?.balance).toBe('20.00');
  });

  it('deduplicates queue redelivery through the persistent inbox', async () => {
    const suffix = randomUUID();
    const wallet = await wallets.create({
      playerId: `player-${suffix}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const payload: CreateWagerTransactionDto = {
      providerId: 'provider-inbox',
      externalTransactionId: `inbox-external-${suffix}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${suffix}`,
      gameId: 'inbox-test',
      kind: 'BET' as CreateWagerTransactionDto['kind'],
      money: { amount: '10.00', currency: 'BRL' },
    };
    const inbox = {
      consumerName: 'integration-test-consumer',
      messageId: `message-${suffix}`,
      payloadHash: 'a'.repeat(64),
    };

    const first = await wagering.submit(payload, `inbox-key-${suffix}`, inbox);
    const redelivery = await wagering.submit(payload, `inbox-key-${suffix}`, inbox);

    expect(first.status).toBe('PROCESSED');
    expect(redelivery.duplicateMessage).toBe(true);
    const rows = await orm.em.getConnection().execute(
      'select balance from wallets where id = ?', [wallet.id],
    ) as Array<{ balance: string }>;
    expect(rows[0]?.balance).toBe('90.00');
  });


  it('rejects reuse of an idempotency key with a different payload', async () => {
    const suffix = randomUUID();
    const wallet = await wallets.create({
      playerId: `player-${suffix}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const payload: CreateWagerTransactionDto = {
      providerId: 'provider-idempotency-conflict',
      externalTransactionId: `idempotency-${suffix}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${suffix}`,
      gameId: 'idempotency-test',
      kind: 'BET' as CreateWagerTransactionDto['kind'],
      money: { amount: '10.00', currency: 'BRL' },
    };
    const key = `same-key-${suffix}`;
    await wagering.submit(payload, key);
    await expect(wagering.submit({
      ...payload,
      money: { amount: '11.00', currency: 'BRL' },
    }, key)).rejects.toThrow('Idempotency-Key was already used with a different payload');
  });

  it('resolves a REFUND that arrived before its BET reference', async () => {
    const suffix = randomUUID();
    const wallet = await wallets.create({
      playerId: `player-${suffix}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const refund = await wagering.submit({
      providerId: 'provider-out-of-order',
      externalTransactionId: `refund-${suffix}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${suffix}`,
      gameId: 'out-of-order-test',
      kind: 'REFUND' as CreateWagerTransactionDto['kind'],
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: `bet-${suffix}`,
    }, `refund-key-${suffix}`);
    expect(refund.status).toBe('PENDING_REFERENCE');

    await wagering.submit({
      providerId: 'provider-out-of-order',
      externalTransactionId: `bet-${suffix}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${suffix}`,
      gameId: 'out-of-order-test',
      kind: 'BET' as CreateWagerTransactionDto['kind'],
      money: { amount: '50.00', currency: 'BRL' },
    }, `bet-key-${suffix}`);

    await orm.em.getConnection().execute(
      `update wager_transactions set next_reference_attempt_at = now() - interval '1 second'
       where id = ?`,
      [refund.transactionId],
    );
    const processed = await wagering.processPendingReferences();
    expect(processed.resolved).toBe(1);

    const transaction = await wagering.findById(refund.transactionId) as { status: string };
    expect(transaction.status).toBe('PROCESSED');
    const reconciliation = await wallets.reconcile(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('100.00');
  });

});
