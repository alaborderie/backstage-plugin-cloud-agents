// @ts-check

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('agents', table => {
    table.string('id').primary();
    table.string('owner_ref').notNullable().index();
    table.text('title').notNullable();
    table.string('repo').notNullable();
    table.string('base').notNullable();
    table.string('branch').notNullable();
    table.string('harness').notNullable();
    table.string('model').notNullable();
    table.string('effort').notNullable();
    table.text('prompt').notNullable();
    table.string('status').notNullable();
    table.text('parent');
    table.text('pr_url');
    table.boolean('stop_requested').notNullable().defaultTo(false);
    table.integer('last_seq').notNullable().defaultTo(0);
    table.string('created_at').notNullable();
    table.string('updated_at').notNullable();
  });

  await knex.schema.createTable('runs', table => {
    table.string('id').primary();
    table
      .string('agent_id')
      .notNullable()
      .references('id')
      .inTable('agents')
      .onDelete('CASCADE');
    table.integer('ordinal').notNullable();
    table.string('reason').notNullable();
    table.text('input');
    table.string('status').notNullable();
    table.string('job_name').notNullable();
    table.string('started_at').notNullable();
    table.string('finished_at');
    table.integer('exit_code');
    table.integer('runner_seq').notNullable().defaultTo(-1);
    table.text('pr_url');
    table.text('error');
    table.unique(['agent_id', 'ordinal']);
    table.index(['status']);
  });

  await knex.schema.createTable('questions', table => {
    table
      .string('run_id')
      .notNullable()
      .references('id')
      .inTable('runs')
      .onDelete('CASCADE');
    table.string('agent_id').notNullable().index();
    table.string('question_id').notNullable();
    table.text('question').notNullable();
    table.text('options').notNullable();
    table.boolean('blocking').notNullable();
    table.text('answer');
    table.string('answered_at');
    table.primary(['run_id', 'question_id']);
  });

  await knex.schema.createTable('events', table => {
    table
      .string('agent_id')
      .notNullable()
      .references('id')
      .inTable('agents')
      .onDelete('CASCADE');
    table.integer('seq').notNullable();
    table.string('run_id').notNullable();
    table.string('type').notNullable();
    table.integer('runner_seq');
    table.text('data').notNullable();
    table.primary(['agent_id', 'seq']);
    table.unique(['run_id', 'runner_seq']);
  });

  await knex.schema.createTable('credentials', table => {
    table.string('owner_ref').notNullable();
    table.string('name').notNullable();
    table.text('sealed').notNullable();
    table.text('meta').notNullable();
    table.string('updated_at').notNullable();
    table.primary(['owner_ref', 'name']);
  });

  await knex.schema.createTable('access_tokens', table => {
    table.string('id').primary();
    table.string('owner_ref').notNullable().index();
    table.string('name').notNullable();
    table.string('token_hash').notNullable().unique();
    table.string('created_at').notNullable();
    table.string('last_used_at');
  });

  await knex.schema.createTable('github_oauth_states', table => {
    table.string('state_hash').primary();
    table.string('owner_ref').notNullable();
    table.string('created_at').notNullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('github_oauth_states');
  await knex.schema.dropTable('access_tokens');
  await knex.schema.dropTable('credentials');
  await knex.schema.dropTable('events');
  await knex.schema.dropTable('questions');
  await knex.schema.dropTable('runs');
  await knex.schema.dropTable('agents');
};
