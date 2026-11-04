import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
const schemaPath = fileURLToPath(new URL('../schema/events.v1.schema.json', import.meta.url));

export function makeValidator(path = schemaPath): (event: unknown) => string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(path, 'utf8')) as object);
  return (event) => (validate(event) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`));
}

/** Checks each line against the schema and the stream rules: one run_id, seq from 0 without gaps, run.started first, run.finished last. */
export function validateStream(text: string, validate = makeValidator()): string[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const problems: string[] = [];
  const events = lines.map((line, i) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      problems.push(`line ${String(i + 1)}: not JSON`);
      return {};
    }
  });
  events.forEach((event, i) => {
    for (const p of validate(event)) problems.push(`line ${String(i + 1)} (${String(event.type)}): ${p}`);
    if (event.seq !== i) problems.push(`line ${String(i + 1)}: seq ${String(event.seq)}, expected ${String(i)}`);
    if (event.run_id !== events[0]?.run_id) problems.push(`line ${String(i + 1)}: run_id differs from line 1`);
  });
  if (events[0]?.type !== 'run.started') problems.push('first event is not run.started');
  if (events.at(-1)?.type !== 'run.finished') problems.push('last event is not run.finished');
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals: files } = parseArgs({ options: { schema: { type: 'string' } }, allowPositionals: true });
  const validate = makeValidator(values.schema);
  let failed = false;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const problems = validateStream(text, validate);
    const count = text.split('\n').filter((l) => l.trim() !== '').length;
    process.stdout.write(`${file}: ${problems.length === 0 ? `ok, ${String(count)} events` : `${String(problems.length)} problems`}\n`);
    for (const p of problems.slice(0, 20)) process.stdout.write(`  ${p}\n`);
    failed ||= problems.length > 0;
  }
  process.exitCode = failed || files.length === 0 ? 1 : 0;
}
