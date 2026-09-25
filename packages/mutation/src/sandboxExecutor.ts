import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, scrubbedEnv, type RunProcessResult } from "./runProcess.js";

/**
 * "none": no network at all (the default -- tests and mutants never need it).
 * "egress": outbound network allowed, used only for dependency installation,
 * which always runs with lifecycle scripts disabled so no PR code executes
 * while the network is up.
 */
export type NetworkPolicy = "none" | "egress";

export interface SandboxCommand {
  /** A node_modules/.bin tool name (vitest, stryker, ...), resolved per executor. */
  tool?: string;
  /** A plain executable on PATH (npm, node, ...). Exactly one of `tool` / `command`. */
  command?: string;
  args: string[];
  /** Host directory holding everything this command may touch. Only this is visible inside a container. */
  workspaceDir: string;
  /** Working directory; must be inside workspaceDir. Defaults to workspaceDir. */
  cwd?: string;
  timeoutMs: number;
  acceptExitCode: (code: number | null) => boolean;
  label: string;
  network?: NetworkPolicy;
  env?: Record<string, string>;
  /**
   * For `tool`: "project" prefers the workspace's own node_modules (a repo's
   * installed Stryker), "reviewer" always uses the reviewer's pinned tooling
   * (vitest/fast-check for generated tests, independent of the repo's versions).
   */
  toolSource?: "project" | "reviewer";
}

export interface SandboxExecutor {
  readonly kind: "local" | "docker";
  /**
   * True when commands run behind an OS-level isolation boundary (container
   * or VM, no host secrets, no network by default). Only isolated executors
   * may run code from an untrusted PR.
   */
  readonly isolated: boolean;
  /** Local executors can be explicitly opted in to untrusted code (e.g. inside an already-disposable CI VM). */
  readonly allowsUntrustedCode: boolean;
  /**
   * Directory containing the reviewer's tooling node_modules (vitest,
   * fast-check, Stryker), as a path seen by the commands this executor
   * runs -- used when writing config files that reference that tooling.
   */
  readonly toolingRoot: string;
  run(command: SandboxCommand): Promise<RunProcessResult>;
}

export class SandboxPolicyError extends Error {}

function assertInside(parent: string, child: string): void {
  const rel = path.relative(parent, child);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SandboxPolicyError(`${child} is outside the sandbox workspace ${parent}`);
  }
}

/** Walks up from `startDir` (not above `stopDir`, if given) to find node_modules/.bin/<tool>. */
export function findToolBin(tool: string, startDir: string, stopDir?: string): string | undefined {
  let dir = path.resolve(startDir);
  const stop = stopDir ? path.resolve(stopDir) : undefined;
  for (let i = 0; i < 25; i++) {
    const candidate = path.join(dir, "node_modules", ".bin", tool);
    if (existsSync(candidate)) return candidate;
    if (stop && dir === stop) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export interface LocalProcessExecutorOptions {
  /**
   * Opt in to running untrusted PR code as a plain child process. Only
   * reasonable when the whole machine is disposable and holds no secrets
   * the code could reach -- e.g. the "execute" job of the GitHub Action,
   * which runs with a read-only token and no repository secrets.
   */
  allowUntrustedCode?: boolean;
}

/**
 * Runs commands as child processes of the reviewer with a scrubbed
 * environment. Not an isolation boundary: fine for the repo's own fixtures
 * and tests, not for arbitrary PRs on a machine that holds credentials.
 */
export class LocalProcessExecutor implements SandboxExecutor {
  readonly kind = "local" as const;
  readonly isolated = false;
  readonly allowsUntrustedCode: boolean;
  readonly toolingRoot = reviewerToolingRoot();

  constructor(options: LocalProcessExecutorOptions = {}) {
    this.allowsUntrustedCode = options.allowUntrustedCode ?? false;
  }

  async run(cmd: SandboxCommand): Promise<RunProcessResult> {
    const cwd = cmd.cwd ?? cmd.workspaceDir;
    assertInside(cmd.workspaceDir, cwd);
    const bin = resolveLocalBinary(cmd, cwd, this.toolingRoot);
    return runProcess(bin, cmd.args, cwd, cmd.timeoutMs, {
      acceptExitCode: cmd.acceptExitCode,
      label: cmd.label,
      env: scrubbedEnv(cmd.workspaceDir, cmd.env),
    });
  }
}

function resolveLocalBinary(cmd: SandboxCommand, cwd: string, toolingRoot: string): string {
  if (cmd.command) return cmd.command;
  if (!cmd.tool) throw new SandboxPolicyError("SandboxCommand needs either `tool` or `command`");
  const reviewerBin = path.join(toolingRoot, "node_modules", ".bin", cmd.tool);
  if (cmd.toolSource === "reviewer") return reviewerBin;
  const bin = findToolBin(cmd.tool, cwd) ?? (existsSync(reviewerBin) ? reviewerBin : undefined);
  if (!bin) throw new Error(`Could not find node_modules/.bin/${cmd.tool} above ${cwd}`);
  return bin;
}

/** The reviewer's own install root: the nearest ancestor of this module with node_modules/.bin/vitest. */
export function reviewerToolingRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bin = findToolBin("vitest", here);
  if (!bin) throw new Error(`Reviewer tooling (vitest) is not installed above ${here}`);
  return path.dirname(path.dirname(path.dirname(bin)));
}

export interface DockerExecutorOptions {
  /** Image with node + the reviewer's tooling at /opt/acrv/node_modules (see infra/sandbox/Dockerfile). */
  image: string;
  dockerBin?: string;
  /** Alternative OCI runtime, e.g. "runsc" for gVisor. Strongly recommended in production. */
  runtime?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  tmpfsSize?: string;
  /** Host uid:gid the container runs as, so the reviewer can read and delete what it writes. */
  user?: string;
}

/** Where a workspace is mounted in the container. Under /opt/acrv so module resolution finds the tooling in /opt/acrv/node_modules. */
export const CONTAINER_WORKSPACE = "/opt/acrv/work";
const CONTAINER_TOOLING_ROOT = "/opt/acrv";
const CONTAINER_TOOLING_BIN = "/opt/acrv/node_modules/.bin";

/**
 * Runs each command in a fresh, throwaway container: no network (unless
 * the command asks for egress), read-only root filesystem, all capabilities
 * dropped, no privilege escalation, memory/CPU/process limits, non-root
 * user, and only the review's own workspace mounted. Nothing from the
 * reviewer's environment is passed in.
 */
export class DockerExecutor implements SandboxExecutor {
  readonly kind = "docker" as const;
  readonly isolated = true;
  readonly allowsUntrustedCode = true;
  readonly toolingRoot = CONTAINER_TOOLING_ROOT;

  constructor(private readonly options: DockerExecutorOptions) {}

  async run(cmd: SandboxCommand): Promise<RunProcessResult> {
    const name = `acrv-${randomUUID()}`;
    const args = this.buildArgs(cmd, name);
    try {
      // The docker CLI itself gets a scrubbed env too (plus DOCKER_HOST if set).
      return await runProcess(this.options.dockerBin ?? "docker", args, cmd.workspaceDir, cmd.timeoutMs, {
        acceptExitCode: cmd.acceptExitCode,
        label: cmd.label,
        env: scrubbedEnv(cmd.workspaceDir, process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      });
    } catch (err) {
      // Killing the docker CLI on timeout doesn't stop the container; do it explicitly.
      await runProcess(this.options.dockerBin ?? "docker", ["rm", "-f", name], cmd.workspaceDir, 30_000, {
        acceptExitCode: () => true,
        label: "docker rm",
      }).catch(() => undefined);
      throw err;
    }
  }

  /** Exposed for tests: the exact `docker run` argument vector. */
  buildArgs(cmd: SandboxCommand, name: string): string[] {
    const workspace = path.resolve(cmd.workspaceDir);
    const cwd = path.resolve(cmd.cwd ?? workspace);
    assertInside(workspace, cwd);
    const containerCwd = path.posix.join(CONTAINER_WORKSPACE, path.relative(workspace, cwd).split(path.sep).join("/"));

    const o = this.options;
    const user = o.user ?? defaultUser();
    const env: Record<string, string> = {
      HOME: "/tmp",
      TMPDIR: "/tmp",
      CI: "true",
      NODE_ENV: "test",
      NO_COLOR: "1",
      npm_config_update_notifier: "false",
      npm_config_cache: "/tmp/.npm",
      ...cmd.env,
    };

    const args = [
      "run",
      "--rm",
      "--init",
      "--name",
      name,
      "--label",
      "acrv.sandbox=1",
      "--network",
      cmd.network === "egress" ? "bridge" : "none",
      "--read-only",
      "--tmpfs",
      `/tmp:rw,exec,nosuid,size=${o.tmpfsSize ?? "1g"}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(o.pidsLimit ?? 512),
      "--memory",
      o.memory ?? "2g",
      "--memory-swap",
      o.memory ?? "2g",
      "--cpus",
      o.cpus ?? "2",
    ];
    if (user) args.push("--user", user);
    if (o.runtime) args.push("--runtime", o.runtime);
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    args.push("-v", `${workspace}:${CONTAINER_WORKSPACE}:rw`, "-w", containerCwd, o.image);
    args.push(this.containerBinary(cmd, workspace, cwd), ...cmd.args);
    return args;
  }

  private containerBinary(cmd: SandboxCommand, workspace: string, cwd: string): string {
    if (cmd.command) return cmd.command;
    if (!cmd.tool) throw new SandboxPolicyError("SandboxCommand needs either `tool` or `command`");
    // Prefer the project's own install (repo-checkout mode), else the image's tooling.
    const hostBin = cmd.toolSource === "reviewer" ? undefined : findToolBin(cmd.tool, cwd, workspace);
    if (hostBin) {
      return path.posix.join(CONTAINER_WORKSPACE, path.relative(workspace, hostBin).split(path.sep).join("/"));
    }
    return path.posix.join(CONTAINER_TOOLING_BIN, cmd.tool);
  }
}

function defaultUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return undefined;
  const uid = process.getuid();
  // Never run the container as root, even if the reviewer itself does.
  return uid === 0 ? "1000:1000" : `${uid}:${process.getgid()}`;
}

/**
 * Picks an executor from the environment:
 *  - ACRV_SANDBOX=docker        -> DockerExecutor (ACRV_SANDBOX_IMAGE, ACRV_DOCKER_RUNTIME=runsc, ...)
 *  - ACRV_SANDBOX=local-unsafe  -> LocalProcessExecutor that may run untrusted code (disposable CI VMs only)
 *  - unset / ACRV_SANDBOX=local -> LocalProcessExecutor that refuses untrusted code
 */
export function createSandboxExecutor(env: NodeJS.ProcessEnv = process.env): SandboxExecutor {
  const mode = env.ACRV_SANDBOX ?? "local";
  switch (mode) {
    case "docker":
      return new DockerExecutor({
        image: env.ACRV_SANDBOX_IMAGE ?? "acrv-sandbox:latest",
        runtime: env.ACRV_DOCKER_RUNTIME || undefined,
        memory: env.ACRV_SANDBOX_MEMORY || undefined,
        cpus: env.ACRV_SANDBOX_CPUS || undefined,
      });
    case "local-unsafe":
      return new LocalProcessExecutor({ allowUntrustedCode: true });
    case "local":
      return new LocalProcessExecutor();
    default:
      throw new Error(`Unknown ACRV_SANDBOX mode "${mode}" (expected docker, local, or local-unsafe)`);
  }
}
