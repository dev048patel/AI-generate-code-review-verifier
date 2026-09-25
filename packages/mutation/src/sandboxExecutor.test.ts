import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTAINER_WORKSPACE,
  createSandboxExecutor,
  DockerExecutor,
  LocalProcessExecutor,
  SandboxPolicyError,
} from "./sandboxExecutor.js";
import { runProcess, scrubbedEnv } from "./runProcess.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "acrv-exec-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("scrubbedEnv / runProcess", () => {
  it("never passes the reviewer's secrets to a child process", async () => {
    process.env.ACRV_TEST_SECRET = "hunter2";
    process.env.GITHUB_TOKEN_TEST_ONLY = "ghs_secret";
    try {
      const { stdout } = await runProcess(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        workspace,
        10_000,
        { acceptExitCode: (c) => c === 0, label: "node" },
      );
      const childEnv = JSON.parse(stdout) as Record<string, string>;
      expect(childEnv.ACRV_TEST_SECRET).toBeUndefined();
      expect(childEnv.GITHUB_TOKEN_TEST_ONLY).toBeUndefined();
      expect(childEnv.HOME).toBe(workspace);
      expect(childEnv.CI).toBe("true");
    } finally {
      delete process.env.ACRV_TEST_SECRET;
      delete process.env.GITHUB_TOKEN_TEST_ONLY;
    }
  });

  it("keeps PATH so tools can still be found", () => {
    expect(scrubbedEnv("/tmp/x").PATH).toBe(process.env.PATH);
  });

  it("kills a process that exceeds its timeout", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], workspace, 300, {
        acceptExitCode: () => true,
        label: "sleeper",
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("LocalProcessExecutor", () => {
  it("refuses a cwd outside the workspace", async () => {
    const executor = new LocalProcessExecutor();
    await expect(
      executor.run({
        command: process.execPath,
        args: ["-e", "0"],
        workspaceDir: workspace,
        cwd: os.tmpdir(),
        timeoutMs: 5_000,
        acceptExitCode: () => true,
        label: "escape",
      }),
    ).rejects.toBeInstanceOf(SandboxPolicyError);
  });

  it("is not isolated and refuses untrusted code unless explicitly opted in", () => {
    expect(new LocalProcessExecutor().isolated).toBe(false);
    expect(new LocalProcessExecutor().allowsUntrustedCode).toBe(false);
    expect(new LocalProcessExecutor({ allowUntrustedCode: true }).allowsUntrustedCode).toBe(true);
  });
});

describe("DockerExecutor.buildArgs", () => {
  const executor = new DockerExecutor({ image: "acrv-sandbox:test", runtime: "runsc", user: "1000:1000" });

  it("locks the container down: no network, read-only, no caps, limits, non-root, gVisor", () => {
    const args = executor.buildArgs(
      { tool: "vitest", args: ["run"], workspaceDir: workspace, timeoutMs: 1000, acceptExitCode: () => true, label: "t" },
      "acrv-x",
    );
    const joined = args.join(" ");
    expect(joined).toContain("--network none");
    expect(args).toContain("--read-only");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--pids-limit 512");
    expect(joined).toContain("--memory 2g");
    expect(joined).toContain("--user 1000:1000");
    expect(joined).toContain("--runtime runsc");
    expect(joined).toContain(`-v ${workspace}:${CONTAINER_WORKSPACE}:rw`);
    // Falls back to the image's tooling when the workspace has no install of its own.
    expect(args.slice(-2)).toEqual(["/opt/acrv/node_modules/.bin/vitest", "run"]);
  });

  it("passes no host environment variables into the container", () => {
    process.env.ACRV_TEST_SECRET = "hunter2";
    try {
      const args = executor.buildArgs(
        { command: "node", args: [], workspaceDir: workspace, timeoutMs: 1000, acceptExitCode: () => true, label: "t" },
        "acrv-x",
      );
      expect(args.join(" ")).not.toContain("hunter2");
      const envFlags = args.filter((_, i) => args[i - 1] === "-e").map((e) => e.split("=")[0]);
      expect(envFlags.sort()).toEqual(
        ["CI", "HOME", "NODE_ENV", "NO_COLOR", "TMPDIR", "npm_config_cache", "npm_config_update_notifier"].sort(),
      );
    } finally {
      delete process.env.ACRV_TEST_SECRET;
    }
  });

  it("only enables the network when a command explicitly asks for egress", () => {
    const args = executor.buildArgs(
      {
        command: "npm",
        args: ["ci", "--ignore-scripts"],
        workspaceDir: workspace,
        timeoutMs: 1000,
        acceptExitCode: () => true,
        label: "install",
        network: "egress",
      },
      "acrv-x",
    );
    expect(args.join(" ")).toContain("--network bridge");
  });

  it("maps cwd and the project's own tool binaries into the container", async () => {
    const repo = path.join(workspace, "repo");
    await mkdir(path.join(repo, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(repo, "node_modules", ".bin", "stryker"), "");
    const args = executor.buildArgs(
      {
        tool: "stryker",
        args: ["run"],
        workspaceDir: workspace,
        cwd: repo,
        timeoutMs: 1000,
        acceptExitCode: () => true,
        label: "t",
      },
      "acrv-x",
    );
    expect(args[args.indexOf("-w") + 1]).toBe(`${CONTAINER_WORKSPACE}/repo`);
    expect(args.slice(-2)).toEqual([`${CONTAINER_WORKSPACE}/repo/node_modules/.bin/stryker`, "run"]);
  });

  it("refuses a cwd outside the workspace", () => {
    expect(() =>
      executor.buildArgs(
        { command: "node", args: [], workspaceDir: workspace, cwd: "/etc", timeoutMs: 1, acceptExitCode: () => true, label: "t" },
        "x",
      ),
    ).toThrow(SandboxPolicyError);
  });
});

describe("createSandboxExecutor", () => {
  it("defaults to a local executor that refuses untrusted code", () => {
    const e = createSandboxExecutor({});
    expect(e.kind).toBe("local");
    expect(e.allowsUntrustedCode).toBe(false);
  });

  it("builds a docker executor from env", () => {
    const e = createSandboxExecutor({ ACRV_SANDBOX: "docker", ACRV_DOCKER_RUNTIME: "runsc" });
    expect(e.kind).toBe("docker");
    expect(e.isolated).toBe(true);
  });

  it("rejects unknown modes instead of silently falling back", () => {
    expect(() => createSandboxExecutor({ ACRV_SANDBOX: "dcoker" })).toThrow(/Unknown ACRV_SANDBOX/);
  });
});
