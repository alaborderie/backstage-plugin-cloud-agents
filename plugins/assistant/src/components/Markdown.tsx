import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './Transcript.module.css';

const PLUGINS = [remarkGfm];

const COMPONENTS = {
  a: ({
    node,
    children,
    ...props
  }: { node?: unknown } & JSX.IntrinsicElements['a']) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

/** GitHub-flavored markdown; a caret follows the last block while `streaming`. */
export function Markdown(props: { text: string; streaming?: boolean }) {
  return (
    <div
      className={styles.markdown}
      data-streaming={props.streaming ? '' : undefined}
    >
      {props.text ? (
        <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
          {props.text}
        </ReactMarkdown>
      ) : (
        props.streaming && <span className={styles.caret} aria-hidden="true" />
      )}
    </div>
  );
}
