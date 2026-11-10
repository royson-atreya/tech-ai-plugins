// Shared basics for the guard: the Block decision and the time budget.
//
// The guard is synchronous, so a setTimeout watchdog could never fire while a
// scan is running. Instead every loop that can grow (tokenizing, expanding,
// scanning folders) calls checkDeadline(); running out of time blocks the call
// (fail-closed) long before Claude Code's own hook timeout, which would let the
// call through.

export class Block extends Error {
  constructor(rule, message) {
    super(message);
    this.rule = rule;
  }
}

let deadline = Infinity;
let ticks = 0;

export function setDeadline(ms) {
  deadline = Date.now() + ms;
}

export function checkDeadline() {
  // Date.now() is cheap, but tokenizer loops call this per character.
  if ((++ticks & 255) !== 0) return;
  if (Date.now() > deadline) {
    throw new Block('timeout', 'the guard ran out of time checking this call; split it into smaller steps or narrow the path');
  }
}

export function timeLeft() {
  return deadline - Date.now();
}
