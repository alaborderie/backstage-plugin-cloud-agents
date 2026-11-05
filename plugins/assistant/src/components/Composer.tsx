import {
  useLayoutEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { ButtonIcon } from '@backstage/ui';
import { RiArrowUpLine, RiStopFill } from '@remixicon/react';
import styles from './Assistant.module.css';

const MAX_HEIGHT = 240;

/** The message field. Enter sends, Shift+Enter breaks the line. */
export function Composer(props: {
  value: string;
  onChange(value: string): void;
  onSend(text: string): void;
  onStop(): void;
  busy: boolean;
  disabled?: boolean;
}) {
  const { value, busy } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const canSend = !busy && !props.disabled && value.trim().length > 0;

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useLayoutEffect(() => {
    if (!busy) field.current?.focus();
  }, [busy]);

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    if (canSend) props.onSend(value.trim());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      send(event);
    }
  };

  return (
    <form className={styles.composer} onSubmit={send} aria-label="Message">
      <textarea
        ref={field}
        className={styles.field}
        aria-label="Message the assistant"
        placeholder="Ask about your catalog, docs, repositories, or agents…"
        rows={1}
        value={value}
        disabled={busy || props.disabled}
        onChange={event => props.onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <ButtonIcon
          variant="secondary"
          aria-label="Stop"
          icon={<RiStopFill />}
          onPress={props.onStop}
        />
      ) : (
        <ButtonIcon
          type="submit"
          variant="primary"
          aria-label="Send"
          icon={<RiArrowUpLine />}
          isDisabled={!canSend}
        />
      )}
    </form>
  );
}
