"""Native messaging host for the "Manual resolution" view.

Chrome starts this for one request from the extension (chrome.runtime.
sendNativeMessage, host name com.local.remerge) and reads one reply. The
request names a GitHub repo, a PR number and a merge commit; the reply is
`git show --remerge-diff --format= <sha>` from a local clone of that repo:
the merge commit's diff against git's own automatic re-merge of its parents,
i.e. only the hand-made part of the conflict resolution.

Repos are mapped to clones in ~/.remerge/repos.json:
    {"owner/repo": "/path/to/clone"}
or, to fetch a private repo over ssh:
    {"owner/repo": {"path": "/path/to/clone", "fetch_url": "git@github.com:owner/repo.git"}}

Only repos in that file are served. Inputs are validated and git is run
without a shell. The commit is fetched (objects only: no ref and no
FETCH_HEAD are written) when the clone does not have it.

Protocol: each message is a 4-byte native-endian length and UTF-8 JSON.
"""

import json
import os
import re
import struct
import subprocess
import sys

CONFIG = os.environ.get('REMERGE_CONFIG') or os.path.expanduser('~/.remerge/repos.json')
GIT = os.environ.get('REMERGE_GIT') or 'git'
MAX_DIFF_BYTES = 900 * 1024      # Chrome caps a host -> extension message at 1 MB
MIN_GIT = (2, 36)                # first release with --remerge-diff

NAME_RE = re.compile(r'^[A-Za-z0-9_.-]{1,100}$')
SHA_RE = re.compile(r'^[0-9a-fA-F]{7,40}$')
FULL_SHA_RE = re.compile(r'^[0-9a-fA-F]{40}$')
PR_RE = re.compile(r'^[0-9]{1,9}$')


class Refusal(Exception):
    pass


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (size,) = struct.unpack('=I', raw)
    return json.loads(sys.stdin.buffer.read(size).decode('utf-8'))


def send_message(obj):
    data = json.dumps(obj).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def git(path, *args, timeout=120):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', LC_ALL='C', GIT_PAGER='cat')
    return subprocess.run([GIT, '-C', path] + list(args), capture_output=True,
                          timeout=timeout, env=env)


def git_version():
    out = subprocess.run([GIT, '--version'], capture_output=True, text=True, timeout=10).stdout
    m = re.search(r'(\d+)\.(\d+)', out)
    if not m:
        raise Refusal('could not read the git version from %r' % out.strip())
    return (int(m.group(1)), int(m.group(2))), out.strip()


def clone_for(owner, repo):
    try:
        with open(CONFIG, encoding='utf-8') as f:
            mapping = json.load(f)
    except FileNotFoundError:
        raise Refusal('no %s; map "%s/%s" to a local clone there' % (CONFIG, owner, repo))
    except ValueError as e:
        raise Refusal('%s is not valid JSON: %s' % (CONFIG, e))
    want = ('%s/%s' % (owner, repo)).lower()
    for key, entry in mapping.items():
        if key.lower() != want:
            continue
        if isinstance(entry, str):
            entry = {'path': entry}
        path = os.path.expanduser(entry.get('path', ''))
        if not os.path.isdir(path):
            raise Refusal('%s maps %s to %s, which is not a directory' % (CONFIG, key, path))
        fetch_url = entry.get('fetch_url') or 'https://github.com/%s/%s.git' % (owner, repo)
        return path, fetch_url
    raise Refusal('"%s/%s" is not mapped to a local clone in %s' % (owner, repo, CONFIG))


def have(path, sha):
    return git(path, 'cat-file', '-e', sha + '^{commit}').returncode == 0


def ensure_commit(path, fetch_url, pr, sha):
    """Fetch sha into the clone if missing: from pull/<pr>/head, else by full
    sha (GitHub serves commits a force push left behind). Objects only."""
    if have(path, sha):
        return
    wants = ['refs/pull/%s/head' % pr] + ([sha] if FULL_SHA_RE.match(sha) else [])
    errors = []
    for want in wants:
        fetched = git(path, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head',
                      fetch_url, want, timeout=300)
        if fetched.returncode != 0:
            errors.append(fetched.stderr.decode('utf-8', 'replace').strip())
        if have(path, sha):
            return
    raise Refusal('commit %s is not fetchable from %s%s'
                  % (sha[:7], fetch_url, (': ' + errors[-1]) if errors else ''))


def common(msg):
    owner, repo, pr = str(msg.get('owner', '')), str(msg.get('repo', '')), str(msg.get('pr', ''))
    if not (NAME_RE.match(owner) and NAME_RE.match(repo)):
        raise Refusal('bad owner/repo')
    if not PR_RE.match(pr):
        raise Refusal('pr must be a number')
    version, version_text = git_version()
    if version < MIN_GIT:
        raise Refusal('%s is too old: this needs git 2.36 or newer' % version_text)
    path, fetch_url = clone_for(owner, repo)
    return pr, path, fetch_url


def capped(raw):
    truncated = len(raw) > MAX_DIFF_BYTES
    text = raw[:MAX_DIFF_BYTES].decode('utf-8', 'replace')
    if truncated:
        text = text[:text.rfind('\n') + 1]
    return text, truncated


def rangediff(msg):
    """git range-diff between two revisions of a PR, each taken against its
    merge base with base_sha (the PR's base commit), so commits are matched up
    and a rebase alone shows as unchanged. Merge commits compare by their
    remerge diff."""
    shas = [str(msg.get(k, '')).lower() for k in ('from', 'to', 'base')]
    if not all(FULL_SHA_RE.match(x) for x in shas):
        raise Refusal('from, to and base must be full 40-character shas')
    pr, path, fetch_url = common(msg)
    for sha in shas:
        ensure_commit(path, fetch_url, pr, sha)
    frm, to, base = shas
    bases = []
    for rev in (frm, to):
        mb = git(path, 'merge-base', rev, base)
        if mb.returncode != 0:
            raise Refusal('%s has no common history with the base %s' % (rev[:7], base[:7]))
        bases.append(mb.stdout.decode().strip())
    ranges = ['%s..%s' % (bases[0], frm), '%s..%s' % (bases[1], to)]
    args = ['range-diff', '--no-color']
    shown = git(path, *(args + ['--diff-merges=remerge'] + ranges), timeout=300)
    if shown.returncode != 0 and b'diff-merges' in shown.stderr:
        shown = git(path, *(args + ranges), timeout=300)   # git before range-diff knew merges
    if shown.returncode != 0:
        raise Refusal('git range-diff failed: ' + shown.stderr.decode('utf-8', 'replace').strip())
    text, truncated = capped(shown.stdout)
    return {'ok': True, 'diff': text, 'truncated': truncated,
            'command': 'git range-diff %s %s' % ('%s..%s' % (bases[0][:9], frm[:9]), '%s..%s' % (bases[1][:9], to[:9]))}


def plain_diff(msg):
    """git diff between two commits of a PR. With "base", the diff is from the
    merge base of "to" and base (the PR as of that revision); otherwise from
    "from" itself (what changed between two revisions)."""
    to = str(msg.get('to', '')).lower()
    frm = str(msg.get('from', '')).lower()
    base = str(msg.get('base', '')).lower()
    if not FULL_SHA_RE.match(to) or not (FULL_SHA_RE.match(frm) or FULL_SHA_RE.match(base)):
        raise Refusal('to and either from or base must be full 40-character shas')
    pr, path, fetch_url = common(msg)
    for sha in (x for x in (to, frm, base) if x):
        ensure_commit(path, fetch_url, pr, sha)
    if base:
        mb = git(path, 'merge-base', to, base)
        if mb.returncode != 0:
            raise Refusal('%s has no common history with the base %s' % (to[:7], base[:7]))
        frm = mb.stdout.decode().strip()
    args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
    if msg.get('ignoreWhitespace'):
        args.append('-w')
    shown = git(path, *(args + [frm, to]), timeout=300)
    if shown.returncode != 0:
        raise Refusal('git diff failed: ' + shown.stderr.decode('utf-8', 'replace').strip())
    text, truncated = capped(shown.stdout)
    return {'ok': True, 'diff': text, 'truncated': truncated,
            'command': 'git diff%s %s %s' % (' -w' if msg.get('ignoreWhitespace') else '', frm[:9], to[:9])}


def remerge(msg):
    sha = str(msg.get('sha', ''))
    if not SHA_RE.match(sha):
        raise Refusal('sha must be 7 to 40 hex characters')
    sha = sha.lower()
    pr, path, fetch_url = common(msg)
    ensure_commit(path, fetch_url, pr, sha)

    parents = git(path, 'rev-list', '--parents', '-n', '1', sha).stdout.decode().split()
    if len(parents) != 3:
        raise Refusal('%s is not a merge of two parents (it has %d)' % (sha[:7], len(parents) - 1))

    args = ['show', '--remerge-diff', '--format=', '--no-color', '--no-ext-diff', '--no-textconv']
    if msg.get('ignoreWhitespace'):
        args.append('-w')
    shown = git(path, *(args + [sha]), timeout=300)
    if shown.returncode != 0:
        raise Refusal('git show failed: ' + shown.stderr.decode('utf-8', 'replace').strip())
    diff, truncated = capped(shown.stdout)
    return {
        'ok': True, 'diff': diff, 'truncated': truncated,
        'sha': sha, 'parents': parents[1:], 'clone': path,
        'command': 'git show --remerge-diff --format=%s %s' % (' -w' if msg.get('ignoreWhitespace') else '', sha),
    }


def handle(msg):
    if not isinstance(msg, dict):
        raise Refusal('request must be a JSON object')
    if msg.get('action') == 'ping':
        _, version_text = git_version()
        return {'ok': True, 'git': version_text, 'config': CONFIG}
    if msg.get('action') == 'rangediff':
        return rangediff(msg)
    if msg.get('action') == 'diff':
        return plain_diff(msg)
    return remerge(msg)


def main():
    try:
        msg = read_message()
        reply = handle(msg)
    except Refusal as e:
        reply = {'ok': False, 'error': str(e)}
    except subprocess.TimeoutExpired as e:
        reply = {'ok': False, 'error': 'git timed out: ' + ' '.join(e.cmd[3:5])}
    except Exception as e:  # report, never hang the extension
        reply = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
    send_message(reply)


if __name__ == '__main__':
    main()
