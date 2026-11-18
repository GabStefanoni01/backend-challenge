import { Migration } from '@mikro-orm/migrations';

export class Migration20261118000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid primary key,
        "player_id" varchar(128) not null,
        "currency" char(3) not null,
        "balance" numeric(20, 2) not null default 0,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wallets_balance_non_negative" check ("balance" >= 0),
        constraint "wallets_version_positive" check ("version" >= 1),
        constraint "wallets_player_currency_unique" unique ("player_id", "currency")
      );

      create table "wager_transactions" (
        "id" uuid primary key,
        "provider_id" varchar(128) not null,
        "external_transaction_id" varchar(256) not null,
        "idempotency_key" varchar(256) not null,
        "payload_hash" char(64) not null,
        "wallet_id" uuid not null references "wallets" ("id"),
        "player_id" varchar(128) not null,
        "round_id" varchar(256) not null,
        "game_id" varchar(256) not null,
        "kind" varchar(16) not null,
        "amount" numeric(20, 2) not null,
        "currency" char(3) not null,
        "reference_external_transaction_id" varchar(256),
        "reference_transaction_id" uuid references "wager_transactions" ("id"),
        "status" varchar(24) not null default 'PENDING',
        "failure_code" varchar(64),
        "result_balance" numeric(20, 2),
        "result_version" integer,
        "processed_at" timestamptz,
        "created_at" timestamptz not null default now(),
        constraint "wager_kind_valid" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_status_valid" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_amount_positive" check ("amount" > 0),
        constraint "wager_provider_external_unique" unique ("provider_id", "external_transaction_id"),
        constraint "wager_provider_idempotency_unique" unique ("provider_id", "idempotency_key")
      );

      create unique index "wager_one_refund_per_reference"
        on "wager_transactions" ("reference_transaction_id")
        where "kind" = 'REFUND' and "reference_transaction_id" is not null;
      create unique index "wager_one_rollback_per_reference"
        on "wager_transactions" ("reference_transaction_id")
        where "kind" = 'ROLLBACK' and "reference_transaction_id" is not null;

      create index "wager_transactions_wallet_created_idx"
        on "wager_transactions" ("wallet_id", "created_at" desc);
      create index "wager_transactions_pending_reference_idx"
        on "wager_transactions" ("created_at")
        where "status" = 'PENDING_REFERENCE';

      create table "wallet_ledger_entries" (
        "id" uuid primary key,
        "wallet_id" uuid not null references "wallets" ("id"),
        "transaction_id" uuid not null references "wager_transactions" ("id"),
        "direction" varchar(8) not null,
        "amount" numeric(20, 2) not null,
        "currency" char(3) not null,
        "balance_before" numeric(20, 2) not null,
        "balance_after" numeric(20, 2) not null,
        "created_at" timestamptz not null default now(),
        constraint "ledger_direction_valid" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "ledger_amount_positive" check ("amount" > 0),
        constraint "ledger_balanced" check (
          ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
          or
          ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
        ),
        constraint "ledger_transaction_wallet_unique" unique ("transaction_id", "wallet_id")
      );

      create index "wallet_ledger_cursor_idx"
        on "wallet_ledger_entries" ("wallet_id", "created_at" desc, "id" desc);

      create function prevent_ledger_mutation() returns trigger as $$
      begin
        raise exception 'wallet ledger entries are immutable';
      end;
      $$ language plpgsql;

      create trigger "wallet_ledger_immutable"
        before update or delete on "wallet_ledger_entries"
        for each row execute function prevent_ledger_mutation();

      create table "inbox_messages" (
        "id" uuid primary key,
        "consumer_name" varchar(128) not null,
        "message_id" varchar(256) not null,
        "payload_hash" char(64) not null,
        "received_at" timestamptz not null default now(),
        "processed_at" timestamptz,
        constraint "inbox_consumer_message_unique" unique ("consumer_name", "message_id")
      );

      create table "outbox_messages" (
        "id" uuid primary key,
        "aggregate_id" uuid not null,
        "event_type" varchar(128) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null default now(),
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz not null default now(),
        "published_at" timestamptz,
        "locked_until" timestamptz,
        "lock_token" uuid,
        constraint "outbox_attempts_non_negative" check ("attempts" >= 0)
      );

      create index "outbox_pending_idx"
        on "outbox_messages" ("next_attempt_at", "occurred_at")
        where "published_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "outbox_messages" cascade;');
    this.addSql('drop table if exists "inbox_messages" cascade;');
    this.addSql('drop trigger if exists "wallet_ledger_immutable" on "wallet_ledger_entries";');
    this.addSql('drop table if exists "wallet_ledger_entries" cascade;');
    this.addSql('drop function if exists prevent_ledger_mutation();');
    this.addSql('drop table if exists "wager_transactions" cascade;');
    this.addSql('drop table if exists "wallets" cascade;');
  }
}
