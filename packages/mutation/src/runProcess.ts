import { spawn } from "node:child_process";

export interface RunProcessOptions {
  acceptExitCode: (code: number | null) => boolean;
  label: string;
  /**
   * The child's complete environment. Defaults to `scrubbedEnv()` -- never
   * the parent's `process.env`, because the parent holds GitHub/LLM/AWS
   * credentials and the child executes code taken from an untrusted PR.
   */
  env?: NodeJS.ProcessEnv;
  /** Cap on captured stdout/stderr (each), so a hostile test can't exhaust reviewer memory. */
  maxOutputBytes?: number;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
}

/**
 * Environment variables a test runner legitimately needs. Everything else --
 * GITHUB_TOKEN, AWS_*, ANTHROPIC_API_KEY, DATABASE_URL, ... -- is dropped.
 */
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "COMSPEC", "PATHEXT"];

/**
 * Builds a minimal environment for running untrusted code: only
 * allowlisted variables from the parent, a HOME/TMPDIR confined to the
 * sandbox, and CI flags so test runners don't try to open watchers or TTYs.
 */
export function scrubbedEnv(sandboxDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: sandboxDir,
    TMPDIR: sandboxDir,
    CI: "true",
    NODE_ENV: "test",
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    ...extra,
  };
}

const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export function runProcess(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? scrubbedEnv(cwd),
      // Own process group, so a timeout kills everything the tests spawned too.
      detached: process.platform !== "win32",
    });
    let stderr = "";
    let stdout = "";
    const killTree = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => {
      killTree();
      reject(new Error(`${options.label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      if (stdout.length < maxOutput) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < maxOutput) stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!options.acceptExitCode(code)) {
        reject(
          new Error(`${options.label} exited with code ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
