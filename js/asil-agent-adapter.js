// ASIL backend adapter — the thin browser-side bridge between Codex's face
// renderer and Claude's backend agent (netlify/functions/asil-agent.js).
//
// It attaches to the event contract the face publishes and NEVER imports or
// mutates the face renderer: on `asil:command` it takes the text, posts it to
// the server agent, then speaks the reply back through the SAME callbacks the
// event handed it (detail.respond / detail.setState) or, as a fallback, through
// window.ASIL. It holds no provider keys and no system prompt — those live
// server-side only.
//
// UMD + factory so it is unit-testable under `node --test`: createAsilAgentAdapter
// takes injectable deps (fetch, getToken, endpoint, now) and returns an object
// with onCommand(detail). The IIFE at the bottom wires the real browser deps and
// registers the window event listener. Loading this with no face present is
// harmless — it just waits for an `asil:command` that never comes.
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AsilAgentAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_ENDPOINT = "/.netlify/functions/asil-agent";
  var MAX_HISTORY = 12; // recent turns kept client-side; durable memory is server-side

  function friendlyError() {
    return "I hit a problem reaching my backend just now. Please try again in a moment.";
  }

  // Speak a reply and/or move the face to a non-speaking state, using ONLY the
  // callbacks the command event provided (never reaching into the renderer).
  // detail.respond(text) makes the face speak; detail.setState(state, d) is used
  // for acting / needs_attention / success / error.
  function deliver(detail, result, fallbackControls) {
    var respond = (detail && typeof detail.respond === "function") ? detail.respond : (fallbackControls && fallbackControls.respond);
    var setState = (detail && typeof detail.setState === "function") ? detail.setState : (fallbackControls && fallbackControls.setState);
    var state = result && result.state;
    if (state && state !== "speaking" && typeof setState === "function") {
      try { setState(state, { source: "asil-agent" }); } catch (e) { /* face owns its own guard */ }
    }
    if (result && result.reply && typeof respond === "function") {
      respond(result.reply);
    }
  }

  function createAsilAgentAdapter(deps) {
    deps = deps || {};
    var doFetch = deps.fetch;
    var getToken = deps.getToken || function () { return null; };
    var endpoint = deps.endpoint || DEFAULT_ENDPOINT;
    var controls = deps.controls || null; // fallback respond/setState (e.g. window.ASIL)
    var history = [];

    function remember(role, text) {
      if (!text) return;
      history.push({ role: role, text: String(text) });
      if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    }

    // Handle one asil:command event detail. Always resolves — a transport
    // failure becomes a spoken apology + needs_attention, never an unhandled
    // rejection that would leave the face stuck in "thinking".
    async function onCommand(detail) {
      var text = detail && detail.text ? String(detail.text) : "";
      if (!text.trim()) return;
      if (typeof doFetch !== "function") {
        deliver(detail, { reply: friendlyError(), state: "needs_attention" }, controls);
        return;
      }
      remember("user", text);
      var token = null;
      try { token = await getToken(); } catch (e) { token = null; }
      var headers = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = "Bearer " + token;
      try {
        var res = await doFetch(endpoint, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({ text: text, history: history.slice(0, -1) })
        });
        if (!res || !res.ok) throw new Error("agent HTTP " + (res && res.status));
        var data = await res.json();
        var reply = data && data.reply ? String(data.reply) : "";
        remember("assistant", reply);
        deliver(detail, { reply: reply || friendlyError(), state: data && data.state }, controls);
      } catch (e) {
        deliver(detail, { reply: friendlyError(), state: "needs_attention" }, controls);
      }
    }

    return {
      onCommand: onCommand,
      getHistory: function () { return history.slice(); },
      clearHistory: function () { history = []; }
    };
  }

  // Browser auto-wiring. Reads an optional token from a host-provided hook so
  // this file never depends on a specific auth library:
  //   window.ASIL_AUTH.getToken()  ->  Promise<string> | string
  // Falls back to window.ASIL for respond/setState if a future face dispatches
  // asil:command WITHOUT inline callbacks.
  function autoWire() {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return null;
    if (window.__asilAgentAdapterWired) return window.__asilAgentAdapter || null;
    var adapter = createAsilAgentAdapter({
      fetch: typeof window.fetch === "function" ? window.fetch.bind(window) : undefined,
      getToken: function () {
        try { return window.ASIL_AUTH && typeof window.ASIL_AUTH.getToken === "function" ? window.ASIL_AUTH.getToken() : null; }
        catch (e) { return null; }
      },
      controls: window.ASIL || null
    });
    window.addEventListener("asil:command", function (event) { adapter.onCommand(event && event.detail); });
    window.__asilAgentAdapterWired = true;
    window.__asilAgentAdapter = adapter;
    return adapter;
  }

  autoWire();

  return { createAsilAgentAdapter: createAsilAgentAdapter, autoWire: autoWire, DEFAULT_ENDPOINT: DEFAULT_ENDPOINT };
});
