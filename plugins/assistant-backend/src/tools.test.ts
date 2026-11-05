import { slimGithub } from './tools';

describe('slimGithub', () => {
  it('keeps what a reader needs from a pull request and drops API noise', () => {
    const pr = {
      url: 'https://api.github.com/repos/o/r/pulls/7',
      html_url: 'https://github.com/o/r/pull/7',
      node_id: 'PR_x',
      number: 7,
      title: 'Add CONTRIBUTING.md',
      body: 'x'.repeat(5000),
      user: { login: 'alice', type: 'User', avatar_url: 'https://a' },
      head: {
        ref: 'cloud-agent/x',
        repo: { full_name: 'o/r', private: false, forks_url: 'https://f' },
      },
      comments_url: 'https://api.github.com/c',
      _links: { self: { href: 'https://api.github.com' } },
    };
    expect(slimGithub([pr])).toEqual([
      {
        html_url: 'https://github.com/o/r/pull/7',
        number: 7,
        title: 'Add CONTRIBUTING.md',
        body: `${'x'.repeat(1500)}…[cut]`,
        user: 'alice',
        head: { ref: 'cloud-agent/x', repo: 'o/r' },
      },
    ]);
  });
});
