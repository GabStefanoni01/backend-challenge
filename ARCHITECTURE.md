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

The initial commit establishes the NestJS application, PostgreSQL/LocalStack development dependencies, and health endpoints. Domain invariants, persistence schema, transaction use cases, inbox/outbox workers, and integration/concurrency tests are implemented incrementally and must be verified before submission.
