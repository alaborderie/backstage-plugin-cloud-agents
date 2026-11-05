// @ts-check

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('conversations', table => {
    table.string('id').primary();
    table.string('owner_ref').notNullable();
    table.text('title').notNullable();
    table.string('created_at').notNullable();
    table.string('updated_at').notNullable();
    table.index(['owner_ref', 'updated_at']);
  });

  await knex.schema.createTable('items', table => {
    table.string('id').primary();
    table
      .string('conversation_id')
      .notNullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE');
    table.integer('seq').notNullable();
    table.string('type').notNullable();
    // The item's fields beyond the columns, as JSON.
    table.text('data').notNullable();
    // The agent an `agent_summary` item summarizes; one summary per agent.
    table.string('summary_of');
    table.string('created_at').notNullable();
    table.unique(['conversation_id', 'seq']);
    table.unique(['conversation_id', 'summary_of']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('items');
  await knex.schema.dropTable('conversations');
};
