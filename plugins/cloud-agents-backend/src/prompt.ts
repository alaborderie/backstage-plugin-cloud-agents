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

/** One child event as a hub run's prompt lists it. */
export interface WakeLine {
  childId: string;
  title: string;
  status: string;
  branch: string;
  prUrl: string | null;
  questions: Array<{ questionId: string; question: string; options: string[] }>;
}

function wakeLines(wake: WakeLine): string[] {
  const child = `- child ${wake.childId} ${JSON.stringify(wake.title)} is ${
    wake.status
  }`;
  if (wake.status === 'needs_input' && wake.questions.length) {
    return wake.questions.map(
      q =>
        `${child}: question ${q.questionId} ${JSON.stringify(
          q.question,
        )} options [${q.options.join(', ')}]`,
    );
  }
  return [`${child} (branch ${wake.branch}, PR ${wake.prUrl ?? 'none'})`];
}

/** What a hub run adds after the objective: one section per kind of news. */
export function hubSections(news: {
  wakes: WakeLine[];
  messages: string[];
  answers: Array<{ questionId: string; question: string; answer: string }>;
}): string | null {
  const sections = [
    news.wakes.length
      ? ['Wake events:', ...news.wakes.flatMap(wakeLines)].join('\n')
      : null,
    news.messages.length
      ? ['Messages from the user:', ...news.messages.map(m => `- ${m}`)].join(
          '\n',
        )
      : null,
    news.answers.length
      ? [
          'Answers from the user:',
          ...news.answers.map(
            a => `- ${a.questionId} ${JSON.stringify(a.question)}: ${a.answer}`,
          ),
        ].join('\n')
      : null,
  ].filter((s): s is string => s !== null);
  return sections.length ? sections.join('\n\n') : null;
}

/** The prompt file of a hub run: the skill, the objective, and what is new since the last run. */
export function hubRunPrompt(objective: string, news: string | null): string {
  return [
    'Use the backstage-hub skill.',
    `Objective:\n${objective}`,
    ...(news ? [news] : []),
  ].join('\n\n');
}
