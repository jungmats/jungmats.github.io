/*
 * Language auto-detection. Include as a blocking script at the top of <head>
 * on every page that has translations:  <script src="/lang.js"></script>
 *
 * Translated pages live at the same path under a language prefix
 * (/x -> /fr/x), and English is the unprefixed default. Only English pages
 * redirect, to the visitor's saved language or else their browser's preferred
 * one. A language URL is treated as a deliberate choice and never redirects.
 * Clicking a .lang-switch link saves the language, so each link needs an
 * hreflang attribute.
 *
 * To add a language, add it to SUPPORTED once its pages are published.
 */
(function () {
  var DEFAULT = 'en';
  var SUPPORTED = [DEFAULT, 'fr'];
  var STORAGE_KEY = 'lang';

  function savedLanguage() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function saveLanguage(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      // Storage is blocked: the choice lasts for this page view only.
    }
  }

  function isOnTranslatedPath() {
    var firstSegment = location.pathname.split('/')[1];
    return firstSegment !== DEFAULT && SUPPORTED.indexOf(firstSegment) !== -1;
  }

  // The first supported language in the browser's order of preference, so a
  // browser set to "en, fr" stays on English.
  function preferredLanguage() {
    var languages = navigator.languages || [navigator.language];
    for (var i = 0; i < languages.length; i++) {
      var base = String(languages[i]).split('-')[0].toLowerCase();
      if (SUPPORTED.indexOf(base) !== -1) return base;
    }
    return DEFAULT;
  }

  function targetLanguage() {
    var saved = savedLanguage();
    return SUPPORTED.indexOf(saved) !== -1 ? saved : preferredLanguage();
  }

  if (!isOnTranslatedPath()) {
    var lang = targetLanguage();
    if (lang !== DEFAULT) {
      location.replace('/' + lang + location.pathname + location.search + location.hash);
      return;
    }
  }

  // This script runs before the page body exists, so listen on the document.
  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('.lang-switch a[hreflang]');
    if (link) saveLanguage(link.getAttribute('hreflang'));
  });
})();
