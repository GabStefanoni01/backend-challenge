import { Migration } from '@mikro-orm/migrations';

export class Migration20261118000400 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "operational_counters" (
        "name" varchar(128) primary key,
        "value" bigint not null default 0,
        "updated_at" timestamptz not null default now(),
        constraint "operational_counter_non_negative" check ("value" >= 0)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "operational_counters";');
  }
}
