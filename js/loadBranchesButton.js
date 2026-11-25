async function loadBranchesButton() {
  var contentView =
    document.getElementsByClassName('clearfix')[0] ||
    document.querySelector('turbo-frame#repo-content-turbo-frame') ||
    document.querySelector('#js-repo-pjax-container') ||
    document.querySelector('main') ||
    document.querySelector('[data-turbo-frame]');

  if (!contentView) {
    console.error('Le Git Graph: contentView not found');
    return;
  }

  var branchSelectionHtml = chrome.runtime.getURL('html/branchSelection.html');
  await fetch(branchSelectionHtml)
    .then((response) => response.text())
    .then((branchSelectionHtmlText) => {
      var tempDiv = document.createElement('div');
      tempDiv.innerHTML = branchSelectionHtmlText;
      var newContent = tempDiv.firstChild;
      contentView.innerHTML = '';
      contentView.appendChild(newContent);
      // Le Git Graph Plus: upstream asked the author's cloud function
      // (us-central1-github-tree-graph.cloudfunctions.net/prompt?userName=...)
      // whether to show a promo image here. Dropped: no calls to third parties.
    });
  return;
}
