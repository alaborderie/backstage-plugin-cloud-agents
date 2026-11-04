export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function rec(value: unknown): Json {
  return isRecord(value) ? value : {};
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export const MAX_TEXT = 16_000;
const MAX_INPUT_STRING = 4_000;

export function clipText(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_TEXT ? { text: text.slice(0, MAX_TEXT), truncated: true } : { text, truncated: false };
}

export function clipInput(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_INPUT_STRING ? `${value.slice(0, MAX_INPUT_STRING)}…[${value.length - MAX_INPUT_STRING} more chars]` : value;
  }
  if (Array.isArray(value)) return value.map(clipInput);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipInput(v)]));
  return value;
}
