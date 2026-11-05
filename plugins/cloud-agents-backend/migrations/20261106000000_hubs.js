// @ts-check

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('agents', table => {
    table.string('kind').notNullable().defaultTo('task');
    table.string('parent_id').index();
    table.text('hub_state');
    table.boolean('stop_by_hub').notNullable().defaultTo(false);
  });

  await knex.schema.createTable('wake_events', table => {
    table.increments('id');
    table
      .string('hub_id')
      .notNullable()
      .references('id')
      .inTable('agents')
      .onDelete('CASCADE');
    table.string('child_id').notNullable();
    table.string('child_status').notNullable();
    table.string('created_at').notNullable();
    table.string('run_id');
    table.index(['hub_id', 'run_id']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('wake_events');
  await knex.schema.alterTable('agents', table => {
    table.dropIndex(['parent_id']);
    table.dropColumn('stop_by_hub');
    table.dropColumn('hub_state');
    table.dropColumn('parent_id');
    table.dropColumn('kind');
  });
};
