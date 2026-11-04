import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { RunnerEvent } from '@alaborderie/plugin-cloud-agents-common';
import schema from './schema/events.v1.schema.json';

const ajv = new Ajv2020({ allErrors: false, strict: false });
addFormats(ajv);
const validate = ajv.compile<RunnerEvent>(schema);

export type ParsedLine =
  | { ok: true; event: RunnerEvent; raw: string }
  | { ok: false; error: string };

/**
 * Parses one stdout line of the runner against events.v1.schema.json. `raw`
 * is the line itself, so the stored and streamed event stays byte for byte
 * what the runner printed.
 */
export function parseRunnerLine(line: string): ParsedLine {
  const raw = line.trim();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (!validate(value)) {
    const first = validate.errors?.[0];
    return {
      ok: false,
      error: `invalid event: ${first?.instancePath || '/'} ${
        first?.message ?? ''
      }`.trim(),
    };
  }
  return { ok: true, event: value, raw };
}
