/**
 * Platform helpers so the app runs unchanged on the target Windows 11 host and
 * on the Linux/macOS dev machines.
 *
 * Server-2 is Windows: backslash paths, `python` (not `python3`), and process
 * signals that differ from POSIX. Everything here is a small, explicit answer
 * to one of those differences.
 */

export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * The Python interpreter to call by default. Windows ships `python`; the
 * POSIX-style `python3` usually does not exist there, so pick per platform.
 * `TTS_PYTHON` / `KOHYA_PYTHON` still override this.
 */
export function defaultPython(): string {
  return isWindows() ? 'python' : 'python3';
}

/** A signal Node accepts on this platform. Windows has no real SIGKILL. */
export function killSignal(): NodeJS.Signals {
  return isWindows() ? 'SIGTERM' : 'SIGKILL';
}
