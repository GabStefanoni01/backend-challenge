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

The Compose stack starts PostgreSQL and LocalStack. The LocalStack initialization script provisions the FIFO transaction queue and its dead-letter queue.

## Database migrations

```bash
bun run db:migrate
```

Roll back the latest migration with:

```bash
bun run db:rollback
```

## Run the API and tests

```bash
bun run start:dev
bun test
```

Health endpoints are available at `/health/live` and `/health/ready`.

Architecture decisions and the authentication scope are documented in [`ARCHITECTURE.md`](../ARCHITECTURE.md).
