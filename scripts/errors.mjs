// How the Runner ends, and the one channel it says so on.
//
// The exit codes are the contract every Forwarder, command and hook is written against, so they are
// one definition rather than one per module: `runner.mjs` dispatches, `environment.mjs` refuses a
// Delegation it cannot run safely and `readiness.mjs` refuses one whose preconditions are missing,
// and all three have to end the same way for the same reason. A module that threw its own error
// type would reach the Runner's top-level catch as something it does not recognise and leave a
// stack trace where a sentence belongs.
//
// stderr is diagnostic by contract, which is why `warn` lives here too: it is the same channel the
// failures go out on, and everything on it is the Runner talking about itself rather than the
// Result it was asked for.

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** Anything that ends the run with a message on stderr and a non-zero exit code. */
export class RunnerError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export const usageError = (message) => new RunnerError(message, EXIT_USAGE);
export const failed = (message) => new RunnerError(message, EXIT_FAILED);

/** Anything the Runner has to say for itself, on the channel that is diagnostic by contract. */
export function warn(message) {
  process.stderr.write(`${message}\n`);
}
