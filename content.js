let blockPatterns = [];
let blockCount = 0;
let processedNodes = new WeakSet(); // Keep track of nodes we've processed
let settings = {
  blockTitle: false,
  redactURLBar: false,
  redactWholePhrase: false,
  redactionChar: '█'
};

function updateBadgeCount() {
  chrome.runtime.sendMessage({
    type: 'updateBadge',
    count: blockCount
  });
}

// Removed local replaceWithBlocks to use the one from utils.js
function getRedactedText(text, pattern) {
  const oldText = text;
  const newText = replaceWithBlocks(text, pattern, settings.redactionChar, settings.redactWholePhrase);
  
  if (newText !== oldText) {
    // Count matches for badge
    try {
      const regex = new RegExp(pattern, 'gi');
      const matches = oldText.match(regex);
      if (matches) {
        blockCount += matches.length;
        updateBadgeCount();
      }
    } catch (e) {}
  }
  return newText;
}

function processTextNode(node) {
  if (processedNodes.has(node)) return;

  let text = node.textContent;
  let modified = false;

  blockPatterns.forEach(({pattern}) => {
    const newText = getRedactedText(text, pattern);
    if (newText !== text) {
      text = newText;
      modified = true;
    }
  });

  if (modified) {
    node.textContent = text;
    processedNodes.add(node);
  }
}

function processVisibleNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    processTextNode(node);
  } else if (node.nodeName !== 'SCRIPT' && node.nodeName !== 'STYLE') {
    // Process child text nodes
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    while (walker.nextNode()) {
      processTextNode(walker.currentNode);
    }
  }
}

// Reset counter when page changes
function resetCounter() {
  blockCount = 0;
  processedNodes = new WeakSet();
  updateBadgeCount();
}

// Create intersection observer
const intersectionObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      processVisibleNode(entry.target);

      // Also observe any new nodes that might be added to this element
      const mutationObserver = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              intersectionObserver.observe(node);
              processVisibleNode(node);
            } else if (node.nodeType === Node.TEXT_NODE) {
              processTextNode(node);
            }
          });
        });
      });

      mutationObserver.observe(entry.target, {
        childList: true,
        subtree: true
      });
    }
  });
}, {
  threshold: 0.1 // Start processing when at least 10% of the element is visible
});

// Initialize
chrome.storage.sync.get([
  'blockPatterns',
  'blockTitle',
  'redactURLBar',
  'redactWholePhrase',
  'redactionChar'
], (result) => {
  if (result.blockPatterns) {
    blockPatterns = result.blockPatterns;
    settings = {
      blockTitle: !!result.blockTitle,
      redactURLBar: !!result.redactURLBar,
      redactWholePhrase: !!result.redactWholePhrase,
      redactionChar: result.redactionChar || '█'
    };

    resetCounter();

    // 1. Redact URL Bar (Experimental)
    if (settings.redactURLBar) {
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      
      const performRedaction = () => {
        const url = new URL(window.location.href);
        let newPath = url.pathname;
        let newSearch = url.search;
        let newHash = url.hash;

        let modified = false;
        blockPatterns.forEach(({pattern}) => {
          const redactedPath = getRedactedText(newPath, pattern);
          const redactedSearch = getRedactedText(newSearch, pattern);
          const redactedHash = getRedactedText(newHash, pattern);

          if (redactedPath !== newPath || redactedSearch !== newSearch || redactedHash !== newHash) {
            newPath = redactedPath;
            newSearch = redactedSearch;
            newHash = redactedHash;
            modified = true;
          }
        });

        if (modified) {
          const newURL = url.origin + newPath + newSearch + newHash;
          originalReplaceState.call(history, null, '', newURL);
        }
      };

      performRedaction();
      
      window.addEventListener('popstate', performRedaction);
      history.pushState = function() {
        originalPushState.apply(this, arguments);
        performRedaction();
      };
      history.replaceState = function() {
        originalReplaceState.apply(this, arguments);
        performRedaction();
      };
    }

    // 3. Redact Title
    if (settings.blockTitle) {
      redactTitle();
      // Observe title changes
      const titleElem = document.querySelector('title');
      if (titleElem) {
        const titleObserver = new MutationObserver(() => redactTitle());
        titleObserver.observe(titleElem, { childList: true });
      }
    }

    // 4. Regular content redaction
    if (document.body) {
      // Observe all existing elements
      const elements = document.body.getElementsByTagName('*');
      for (const element of elements) {
        intersectionObserver.observe(element);
      }

      // Observe new elements being added to the body
      const bodyObserver = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              intersectionObserver.observe(node);
              const childElements = node.getElementsByTagName('*');
              for (const element of childElements) {
                intersectionObserver.observe(element);
              }
            }
          });
        });
      });

      bodyObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  }
});

function redactTitle() {
  let title = document.title;
  let modified = false;
  blockPatterns.forEach(({pattern}) => {
    const newTitle = getRedactedText(title, pattern);
    if (newTitle !== title) {
      title = newTitle;
      modified = true;
    }
  });
  if (modified) {
    document.title = title;
  }
}

// Handle visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    resetCounter();
    // Re-process visible elements
    const elements = document.body.getElementsByTagName('*');
    for (const element of elements) {
      if (isElementInViewport(element)) {
        processVisibleNode(element);
      }
    }
  }
});

// Utility function to check if element is in viewport
function isElementInViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}