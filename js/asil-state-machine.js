(function(root, factory){
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AsilStateMachine = api.AsilStateMachine;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";
  var STATES = ["idle", "listening", "understanding", "thinking", "speaking", "acting", "needs_attention", "success", "error"];
  var ALLOWED = {
    idle: STATES.slice(),
    listening: ["idle", "understanding", "thinking", "error"],
    understanding: ["idle", "thinking", "speaking", "error"],
    thinking: ["idle", "speaking", "acting", "needs_attention", "success", "error"],
    speaking: ["idle", "listening", "acting", "success", "error"],
    acting: ["idle", "thinking", "speaking", "needs_attention", "success", "error"],
    needs_attention: ["idle", "listening", "thinking", "acting", "error"],
    success: ["idle", "listening", "speaking", "acting", "error"],
    error: ["idle", "listening", "thinking"]
  };
  function AsilStateMachine(initialState){
    this.state = STATES.indexOf(initialState) >= 0 ? initialState : "idle";
    this.previousState = null;
    this.listeners = [];
  }
  AsilStateMachine.prototype.canTransition = function(nextState){
    return STATES.indexOf(nextState) >= 0 && ALLOWED[this.state].indexOf(nextState) >= 0;
  };
  AsilStateMachine.prototype.transition = function(nextState, detail){
    if (nextState === this.state) return this.snapshot(detail);
    if (!this.canTransition(nextState)) throw new Error("ASIL cannot transition from " + this.state + " to " + nextState);
    this.previousState = this.state;
    this.state = nextState;
    var snapshot = this.snapshot(detail);
    this.listeners.slice().forEach(function(listener){ listener(snapshot); });
    return snapshot;
  };
  AsilStateMachine.prototype.snapshot = function(detail){
    return { state: this.state, previousState: this.previousState, detail: detail || null, timestamp: Date.now() };
  };
  AsilStateMachine.prototype.subscribe = function(listener){
    if (typeof listener !== "function") throw new TypeError("ASIL state listener must be a function");
    this.listeners.push(listener);
    var self = this;
    return function(){ self.listeners = self.listeners.filter(function(item){ return item !== listener; }); };
  };
  return { AsilStateMachine: AsilStateMachine, STATES: STATES.slice() };
});
