(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__isaTrack) return;
  window.__isaTrack = true;

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();
  var trackingId = script && script.getAttribute('data-t');
  var endpoint   = (script && script.getAttribute('data-e')) || '/api/track/event';
  var userId     = script && script.getAttribute('data-u');
  if (!trackingId) return;

  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;

  var lastPath = null;

  function send(eventType, name, data) {
    var path = location.pathname;
    if (eventType === 'pageview' && path === lastPath) return;
    if (eventType === 'pageview') lastPath = path;

    var body = {
      t: trackingId,
      p: path,
      q: location.search ? location.search.slice(1) : null,
      r: document.referrer || null,
      s: screen.width + 'x' + screen.height,
      l: navigator.language || null,
      ti: (document.title || '').slice(0, 200),
      e: eventType,
      u: userId || null
    };
    if (name) body.n = name;
    if (data) body.d = data;

    try {
      var payload = JSON.stringify(body);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([payload], { type: 'application/json' }));
      } else {
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
          credentials: 'omit'
        }).catch(function () {});
      }
    } catch (_) { /* swallow */ }
  }

  function trackPageview() { send('pageview'); }

  var track = function (name, data) { send('custom', name, data); };
  track.pageview = trackPageview;
  track.event = function (name, data) { send('custom', name, data); };
  window.isaTrack = track;

  // Patch history methods for any vanilla SPA that uses them directly.
  // Note: if a framework (e.g. Next.js) captures history.pushState before
  // this script loads, it will bypass the patch — that's why we also
  // expose window.isaTrack.pageview() for the framework layer to call.
  var pushState = history.pushState;
  history.pushState = function () {
    var ret = pushState.apply(this, arguments);
    setTimeout(trackPageview, 0);
    return ret;
  };
  var replaceState = history.replaceState;
  history.replaceState = function () {
    var ret = replaceState.apply(this, arguments);
    setTimeout(trackPageview, 0);
    return ret;
  };
  window.addEventListener('popstate', function () { setTimeout(trackPageview, 0); });

  // Auto-track outbound link clicks and file downloads.
  var DOWNLOAD_RE = /\.(pdf|zip|tar|gz|rar|7z|csv|xlsx?|docx?|pptx?|dmg|exe|apk|mp3|mp4|mov|wav|svg|png|jpe?g|gif)(\?.*)?$/i;

  function onClick(ev) {
    try {
      var a = ev.target;
      while (a && a.nodeType === 1 && a.tagName !== 'A') a = a.parentNode;
      if (!a || a.tagName !== 'A') return;
      var href = a.getAttribute('href');
      if (!href) return;
      var isDownload = DOWNLOAD_RE.test(href);
      var isOutbound = false;
      try {
        var u = new URL(href, location.href);
        isOutbound = u.hostname && u.hostname !== location.hostname;
      } catch (_) { /* relative href, skip */ }
      if (isDownload) {
        send('custom', 'download', { href: href.slice(0, 500) });
      } else if (isOutbound) {
        send('custom', 'outbound', { href: href.slice(0, 500), target: a.hostname });
      }
    } catch (_) { /* swallow */ }
  }
  document.addEventListener('click', onClick, true);

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    trackPageview();
  } else {
    document.addEventListener('DOMContentLoaded', trackPageview);
  }
})();
