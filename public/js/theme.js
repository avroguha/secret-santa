// Applied before the first paint so a dark-mode visitor never sees a white flash.
// The preference is a per-browser convenience; storage may be unavailable.
(function () {
  var theme = 'auto';
  try { theme = localStorage.getItem('santa.theme') || 'auto'; } catch (e) { /* private window */ }
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
}());
