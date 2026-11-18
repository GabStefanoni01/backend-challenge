import { Migration } from '@mikro-orm/migrations';

export class Migration20261118000200 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "reference_attempts" integer not null default 0,
        add column "next_reference_attempt_at" timestamptz not null default (now() + interval '5 seconds'),
        add column "reference_expires_at" timestamptz not null default (now() + interval '24 hours');

      alter table "wager_transactions"
        add constraint "wager_reference_attempts_non_negative"
        check ("reference_attempts" >= 0);

      create index "wager_pending_reference_due_idx"
        on "wager_transactions" ("next_reference_attempt_at", "created_at")
        where "status" = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "wager_pending_reference_due_idx";');
    this.addSql('alter table "wager_transactions" drop constraint if exists "wager_reference_attempts_non_negative";');
    this.addSql('alter table "wager_transactions" drop column if exists "reference_expires_at";');
    this.addSql('alter table "wager_transactions" drop column if exists "next_reference_attempt_at";');
    this.addSql('alter table "wager_transactions" drop column if exists "reference_attempts";');
  }
}
