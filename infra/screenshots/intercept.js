// Injected before page scripts run. Monkey-patches window.fetch so any API
// call to /admin/api/* or /self/api/* resolves from window.__SCREENSHOT_FIXTURES__
// instead of hitting the network. Anything we don't match passes through.

(function () {
  const fixtures = window.__SCREENSHOT_FIXTURES__ || {};
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input.url;
    let pathname;
    try {
      pathname = new URL(url, window.location.origin).pathname;
    } catch {
      return originalFetch(input, init);
    }
    if (!pathname.startsWith("/admin/api/") && !pathname.startsWith("/self/api/")) {
      return originalFetch(input, init);
    }

    const method = ((init && init.method) || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    const key = method + " " + pathname;
    const match = fixtures[key] ?? fixtures["GET " + pathname];
    if (match === undefined) {
      // Fail visibly so a missing fixture is obvious in the screenshot.
      const body = JSON.stringify({ ok: false, error: "fixture_missing:" + key });
      return new Response(body, { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(match), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
})();
