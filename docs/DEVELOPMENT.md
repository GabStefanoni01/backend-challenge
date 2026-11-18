# Local development

## Requirements

- Bun 1.x
- Docker Engine and Docker Compose

## Start dependencies

```bash
bun install
cp .env.example .env
docker compose up -d
```

The Compose stack starts PostgreSQL and LocalStack. LocalStack provisions three FIFO queues:
- `wager-transactions.fifo`: inbound provider requests;
- `wager-transactions-dlq.fifo`: permanently invalid messages and messages exceeding the retry limit;
- `wager-events.fifo`: integration events published by the transactional outbox.

The API and background workers use the same process. Set `WORKERS_ENABLED=false` to run only the HTTP API during focused tests.

## Database migrations

Run the versioned migrations after the dependencies are healthy:

```bash
bun --env-file=.env run db:migrate
```

Roll back the latest migration with:

```bash
bun --env-file=.env run db:rollback
```

## Run the API and tests

```bash
bun run start:dev
bun run test
```

The test command intentionally targets `src` only, avoiding a second execution of compiled tests under `dist`.

Health endpoints:
- `GET /health/live`: process liveness;
- `GET /health/ready`: PostgreSQL and SQS readiness.

## Queue message contract

Publish a JSON message to `wager-transactions.fifo` with this envelope:

```json
{
  "messageId": "provider-message-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-18T12:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "player-123",
    "walletId": "00000000-0000-4000-8000-000000000001",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

The consumer records the SQS message in the PostgreSQL inbox in the same transaction as the financial use case. It deletes the SQS message only after commit. Duplicate deliveries are acknowledged without repeating the financial effect.

The outbox publisher claims rows using `FOR UPDATE SKIP LOCKED`, sends them to the events FIFO queue, and marks them published only after SQS confirms the send. A crash between send and database acknowledgement may cause a duplicate publication; event consumers must therefore be idempotent.

## Pending references

REFUND, ROLLBACK, or referenced WIN messages whose source transaction has not arrived are stored as `PENDING_REFERENCE`. The worker retries after 5, 10, 20, 40, 80, 160 seconds and then at a capped 300-second interval. It rejects after 12 attempts or the 24-hour TTL, whichever comes first.

Architecture decisions and the authentication scope are documented in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## Metrics

The Prometheus exposition endpoint is available at `GET /metrics`. It reports persisted transaction counts by status, idempotency replays, duplicate SQS deliveries, transient retries, DLQ depth, outbox retries and lag, pending-reference retries, PostgreSQL lock waiters, and average processing latency.
