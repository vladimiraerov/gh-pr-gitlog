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


def remerge(msg):
    owner, repo = str(msg.get('owner', '')), str(msg.get('repo', ''))
    sha, pr = str(msg.get('sha', '')), str(msg.get('pr', ''))
    if not (NAME_RE.match(owner) and NAME_RE.match(repo)):
        raise Refusal('bad owner/repo')
    if not SHA_RE.match(sha):
        raise Refusal('sha must be 7 to 40 hex characters')
    if not PR_RE.match(pr):
        raise Refusal('pr must be a number')
    sha = sha.lower()

    version, version_text = git_version()
    if version < MIN_GIT:
        raise Refusal('%s is too old: --remerge-diff needs git 2.36 or newer' % version_text)
    path, fetch_url = clone_for(owner, repo)

    if git(path, 'cat-file', '-e', sha + '^{commit}').returncode != 0:
        fetched = git(path, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head',
                      fetch_url, 'refs/pull/%s/head' % pr, timeout=300)
        if fetched.returncode != 0:
            raise Refusal('git fetch %s pull/%s/head failed: %s'
                          % (fetch_url, pr, fetched.stderr.decode('utf-8', 'replace').strip()))
        if git(path, 'cat-file', '-e', sha + '^{commit}').returncode != 0:
            raise Refusal('commit %s is not in pull/%s/head of %s' % (sha, pr, fetch_url))

    parents = git(path, 'rev-list', '--parents', '-n', '1', sha).stdout.decode().split()
    if len(parents) != 3:
        raise Refusal('%s is not a merge of two parents (it has %d)' % (sha[:7], len(parents) - 1))

    args = ['show', '--remerge-diff', '--format=', '--no-color', '--no-ext-diff', '--no-textconv']
    if msg.get('ignoreWhitespace'):
        args.append('-w')
    shown = git(path, *(args + [sha]), timeout=300)
    if shown.returncode != 0:
        raise Refusal('git show failed: ' + shown.stderr.decode('utf-8', 'replace').strip())
    raw = shown.stdout
    truncated = len(raw) > MAX_DIFF_BYTES
    diff = raw[:MAX_DIFF_BYTES].decode('utf-8', 'replace')
    if truncated:
        diff = diff[:diff.rfind('\n') + 1]
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
