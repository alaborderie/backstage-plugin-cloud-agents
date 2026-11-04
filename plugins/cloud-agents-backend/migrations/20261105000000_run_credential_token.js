// @ts-check

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('runs', table => {
    table.string('credential_token_hash').unique();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('runs', table => {
    table.dropUnique(['credential_token_hash']);
    table.dropColumn('credential_token_hash');
  });
};
