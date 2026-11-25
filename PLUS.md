# Le Git Graph Plus

le-git-graph plus two additions, installed as one extension:

- **PR graph**: on a pull request page, a `git log --graph --oneline --decorate` panel under the PR title. It shows the PR commits, the base branch commits since they diverged, and the history down to where every line joins. ↻ reloads it.
- **File tree**: the ☰ button (bottom left) opens a sidebar. On a repo page it shows the repository tree at the branch you are viewing; on a PR it shows the changed files with `+/−` counts, and a click jumps to the diff.
- **Commits tab**: le-git-graph's whole-repo graph, unchanged.

## Install

Chrome / Edge / Brave: `chrome://extensions` → Developer mode → Load unpacked → this folder.
After pulling changes, press ↻ on the extension card and reload the GitHub tab.

Firefox (until restart): `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `manifest.json`.

## Token

Without a token GitHub allows 60 API calls per hour per IP, enough for light use on public repos.
For more, or for private repos:

1. https://github.com/settings/tokens/new: classic token, no scopes for public repos (`repo` for private).
2. For an org with SAML SSO: Configure SSO → Authorize, next to the token.
3. Any repo → Commits tab → paste the token → Save token.

The token is kept in this browser's github.com localStorage and sent only to `api.github.com`.
If an org rejects it (SAML), requests for that org go anonymous.

## Differences from upstream

- No sign-in through the le-git-graph author's server, and no call to the author's cloud function; the extension talks only to GitHub.
- No first-run tour tab on install.
- The Commits tab is added whenever a repo nav bar appears (late rendering, in-app navigation), without console errors on pages that have none.

New code lives in `js/common`, `js/pr`, `js/tree` and `css/` so upstream merges stay small:
`git fetch upstream && git merge upstream/main`.

## Tests

- `node test/ascii.js <owner> <repo> <pr>`: prints the PR graph as text.
- `node test/vs-git.js <owner> <repo> <pr> <clone> <base>`: checks the commit set and order against `git log` in a local clone with the PR head fetched as `pr<N>`.
- `test/e2e.js`: loads the extension in Chromium and checks the panels render (needs `playwright-core`; see the file header).

Set `GITHUB_TOKEN` for the first two to avoid the anonymous limit.
