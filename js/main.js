// The first thing that the extension should do is add a 'commits' button.
// Everything else happens only if the user clicks on it.

// Hence every other function/service is called only if the user clicks on the button.

// The commits button is to be added on all repositories.
// Trying to filter out github's reserved pages, like login. (Veryyyy incomplete. Github has many more URLs.)

var pathsToExclude = ["login", "oauth", "authorize"];

// Le Git Graph Plus: upstream called addCommitsButton() once at load. On pages
// without a repo nav bar (home, notifications) that logged "Could not find
// repository navigation bar", and when the nav bar appeared later (React
// rendering it late, or in-app navigation from the home page into a repo) the
// tab was never added. Instead, add it whenever a repo nav bar is present and
// the tab is missing, and stay quiet otherwise. Selectors match addCommitsButton.js.
var repoNavSelectors = [
    'nav[aria-label="Repository"] ul',
    'ul[class*="UnderlineItemList"]',
    'nav[class*="LocalNavigation"] ul',
];

function ensureCommitsButton() {
    if (pathsToExclude.includes(window.location.pathname.split("/")[1])) return;
    if (document.getElementById('commits-tab')) return;
    var hasNav = repoNavSelectors.some(function (s) { return document.querySelector(s); });
    if (hasNav) addCommitsButton();
}

var commitsButtonCheckPending = false;
new MutationObserver(function () {
    if (commitsButtonCheckPending) return;
    commitsButtonCheckPending = true;
    setTimeout(function () { commitsButtonCheckPending = false; ensureCommitsButton(); }, 300);
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('turbo:load', ensureCommitsButton);
ensureCommitsButton();