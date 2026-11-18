# Architecture decisions

## Scope and priorities

This service prioritizes financial correctness, persistent idempotency, concurrency safety, and recoverable asynchronous processing. Authentication is intentionally out of scope for the time-boxed challenge because it has no evaluation points. The HTTP boundary will expose an explicit provider-identity extension point before production use; queue messages are treated as an internal trusted channel, while provider and domain fields are still validated.

## Stack

- Bun 1.x for runtime, package management, and tests.
- TypeScript strict mode and NestJS for HTTP and dependency boundaries.
- PostgreSQL as the source of truth.
- MikroORM for persistence and versioned migrations.
- AWS SQS FIFO through LocalStack for local development; broker ordering is an optimization, never the correctness boundary.
- `decimal.js` for exact decimal arithmetic in the domain. Monetary API values remain decimal strings and database amounts use `NUMERIC`, never JavaScript `number`.

## Financial consistency

Wallet mutations, transaction state, immutable ledger entries, inbox records, and outbox events must be committed in one PostgreSQL transaction. Wallet-level row locks (`SELECT ... FOR UPDATE`) serialize operations against one wallet while allowing unrelated wallets to progress concurrently. Unique constraints provide the final protection for provider transaction identity, idempotency keys, and one ledger entry per transaction and wallet. A database check constraint prevents negative balances.

## Messaging

The inbox is the durable deduplication boundary for SQS consumers. Messages are acknowledged only after the database transaction commits. The transactional outbox is written in the same transaction as the financial state and is published asynchronously after commit. Delivery is at-least-once; consumers must be idempotent.

## Authentication decision

Authentication is not implemented in this challenge. Before exposing the service publicly, integrate an external OIDC identity provider (for example Keycloak or Zitadel) and validate provider identity at the HTTP boundary. Do not add a home-grown user/password store.

## Known implementation status

## Concurrency and idempotency

- Each wager is processed inside a PostgreSQL transaction.
- `SELECT ... FOR UPDATE` locks only the target wallet row. This serializes writes to one wallet without blocking unrelated wallets.
- Provider/external transaction identity and provider/idempotency key are protected by unique constraints.
- The idempotency hash is SHA-256 over a stable JSON representation of business fields. Replays return the stored result snapshot; a changed payload for the same key is a conflict.
- SQS deliveries are deduplicated by `(consumer_name, message_id)` in the inbox. The inbox insert, financial use case, ledger, and outbox writes share the same SQL transaction.

## Outbox delivery semantics

Publishers claim due rows with `FOR UPDATE SKIP LOCKED` and a time-limited lock token. The event is sent to the separate `wager-events.fifo` queue and marked published only after SQS confirms the send. A crash after send but before marking the row can produce a duplicate event; this is intentional at-least-once delivery, so downstream event consumers must deduplicate by `eventId`.

## Out-of-order references

Missing REFUND, ROLLBACK, and explicitly referenced WIN operations are stored as `PENDING_REFERENCE`. The worker retries with exponential backoff (5 seconds up to a 300-second cap) and rejects after 12 attempts or a 24-hour TTL. Resolving a reference rechecks provider, player, wallet, round, currency, type, amount, and duplicate-reversal constraints while holding the wallet lock.

## Operational behavior

- `WORKERS_ENABLED=false` disables background loops for focused local debugging.
- `/health/ready` checks both PostgreSQL and the inbound/outbound SQS queues.
- LocalStack creates separate inbound, dead-letter, and integration-event FIFO queues.
- The integration suite uses real PostgreSQL connections and independent MikroORM instances to exercise multi-instance wallet locking.

The implementation is still subject to the latest CI run; do not treat a green build as a substitute for the financial and messaging integration tests.
