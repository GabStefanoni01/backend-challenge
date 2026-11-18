import { Migration } from '@mikro-orm/migrations';

export class Migration20261118000300 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      drop index if exists "wager_one_refund_per_reference";
      drop index if exists "wager_one_rollback_per_reference";

      create unique index "wager_one_refund_per_reference"
        on "wager_transactions" ("reference_transaction_id")
        where "kind" = 'REFUND'
          and "status" = 'PROCESSED'
          and "reference_transaction_id" is not null;

      create unique index "wager_one_rollback_per_reference"
        on "wager_transactions" ("reference_transaction_id")
        where "kind" = 'ROLLBACK'
          and "status" = 'PROCESSED'
          and "reference_transaction_id" is not null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index if exists "wager_one_refund_per_reference";
      drop index if exists "wager_one_rollback_per_reference";

      create unique index "wager_one_refund_per_reference"
        on "wager_transactions" ("reference_transaction_id")
        where "kind" = 'REFUND' and "reference_transaction_id" is not null;

      create unique index "wager_one_rollback_per_reference"
        on "wager_transactions" ("reference_transaction_id")
        where "kind" = 'ROLLBACK' and "reference_transaction_id" is not null;
    `);
  }
}
