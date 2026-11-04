/** What a reply or message run adds to the agent's original prompt. */
export function replySection(
  branch: string,
  answers: Array<{ question: string; answer: string }>,
): string {
  return [
    '## Answers to your questions',
    '',
    `An earlier run on branch \`${branch}\` stopped to ask these questions. The branch holds the work it pushed. Continue from there with these answers.`,
    ...answers.flatMap(a => ['', `### ${a.question}`, '', a.answer]),
  ].join('\n');
}

export function messageSection(branch: string, text: string): string {
  return [
    '## Follow-up message',
    '',
    `Earlier runs worked on branch \`${branch}\`. The branch holds the work they pushed. Continue from there.`,
    '',
    text,
  ].join('\n');
}

/** The prompt file of a run: the original brief, then each later input in order. */
export function runPrompt(original: string, inputs: string[]): string {
  return [original, ...inputs].join('\n\n');
}
