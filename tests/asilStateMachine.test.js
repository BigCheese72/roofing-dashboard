const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AsilStateMachine, STATES } = require("../js/asil-state-machine.js");

test("ASIL exposes the complete visible state vocabulary", () => {
  assert.deepEqual(STATES, ["idle", "listening", "understanding", "thinking", "speaking", "acting", "needs_attention", "success", "error"]);
});
test("ASIL follows the normal voice turn lifecycle", () => {
  const machine = new AsilStateMachine();
  const seen = [];
  machine.subscribe(snapshot => seen.push(snapshot.state));
  machine.transition("listening");
  machine.transition("understanding");
  machine.transition("thinking");
  machine.transition("speaking");
  machine.transition("idle");
  assert.deepEqual(seen, ["listening", "understanding", "thinking", "speaking", "idle"]);
});
test("ASIL rejects impossible direct transitions", () => {
  const machine = new AsilStateMachine("listening");
  assert.throws(() => machine.transition("acting"), /cannot transition/);
  assert.equal(machine.state, "listening");
});
test("subscribers can detach cleanly", () => {
  const machine = new AsilStateMachine();
  let calls = 0;
  const unsubscribe = machine.subscribe(() => calls++);
  machine.transition("thinking");
  unsubscribe();
  machine.transition("idle");
  assert.equal(calls, 1);
});
test("ASIL page loads the face modules and exposes accessible controls", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "asil.html"), "utf8");
  const face = fs.readFileSync(path.join(__dirname, "..", "js", "asil-face.js"), "utf8");
  assert.match(html, /id="asil-canvas"/);
  assert.match(html, /id="asil-mic"[^>]+aria-pressed="false"/);
  assert.match(html, /id="asil-command"[^>]+aria-label="Message ASIL"/);
  assert.match(html, /js\/asil-state-machine\.js/);
  assert.match(html, /js\/asil-face\.js/);
  assert.doesNotMatch(html, /unpkg\.com\/three/);
  assert.match(face, /vendor\/three\.module\.min\.js/);
});
test("backend integration stays event-based and does not embed provider secrets", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "asil-face.js"), "utf8");
  assert.match(source, /CustomEvent\("asil:command"/);
  assert.match(source, /window\.ASIL\s*=/);
  assert.doesNotMatch(source, /ANTHROPIC_API_KEY|OPENAI_API_KEY|sk-ant-|sk-proj-/);
});
