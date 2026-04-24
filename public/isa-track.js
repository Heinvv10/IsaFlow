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
    lastPath = path;

    var body = {
      t: trackingId,
      p: path,
      q: location.search ? location.search.slice(1) : null,
      r: document.referrer || null,
      s: screen.width + 'x' + screen.height,
      l: navigator.language || null,
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

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    trackPageview();
  } else {
    document.addEventListener('DOMContentLoaded', trackPageview);
  }
})();
