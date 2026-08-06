import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTestSandbox } from "../support/test-sandbox.js";
import "../support/register-managed-runtime-private-owner-fixture.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const managed = (await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin", "managed-runtime-service.js"),
  ).href
)) as typeof import("../../src/core/rin/managed-runtime-service.js") &
  Record<string, (...args: any[]) => any>;

function actionContext(root: string, overrides: Record<string, unknown> = {}) {
  const events: unknown[][] = [];
  const context = {
    installDir: path.join(root, "install"),
    targetUser: "owner",
    currentUser: "owner",
    isTargetUser: true,
    agentDir: path.join(root, "agent"),
    systemctl: "/usr/bin/systemctl",
    exec(argv: string[]) {
      events.push(["exec", argv]);
    },
    capture(argv: string[]) {
      events.push(["capture", argv]);
      return "";
    },
    async canConnectSocket() {
      return false;
    },
    readJson() {
      return null;
    },
    readPrivilegedJson() {
      return null;
    },
    targetPathExists(filePath: string) {
      return filePath.startsWith(root);
    },
    ...overrides,
  } as any;
  return { context, events };
}

test("managed runtime reads authoritative service manifests and validates action paths", async () => {
  const sandbox = await createTestSandbox("managed-runtime-read-owner");
  try {
    const servicePath = path.join(path.dirname(sandbox.home), "owner.service");
    await fs.writeFile(servicePath, "owner", "utf8");
    const reads = {
      installDir: path.join(path.dirname(sandbox.home), "install"),
      targetUser: "owner",
      currentUser: "owner",
      readJson: () => ({
        service: {
          kind: "systemd",
          label: " rin-daemon.service ",
          path: ` ${servicePath} `,
        },
      }),
      readPrivilegedJson: () => null,
    } as any;
    assert.deepEqual(managed.readManagedRuntimeService(reads), {
      kind: "systemd",
      label: "rin-daemon.service",
      path: servicePath,
    });
    for (const service of [
      null,
      { kind: "invalid", label: "owner" },
      { kind: "systemd", label: "" },
    ]) {
      assert.throws(
        () =>
          managed.readManagedRuntimeService({
            ...reads,
            readJson: () => ({ service }),
          }),
        /rin_managed_service_missing/,
      );
    }

    const { context } = actionContext(path.dirname(sandbox.home), {
      targetPathExists: () => false,
    });
    await assert.rejects(
      () =>
        managed.tryManagedServiceAction(context, "start", {
          kind: "systemd",
          label: "owner.service",
          path: path.join(path.dirname(sandbox.home), "missing.service"),
        }),
      /rin_managed_service_missing_path/,
    );
    await assert.rejects(
      () =>
        managed.tryManagedServiceAction(context, "start", {
          kind: "invalid",
          label: "owner",
        } as any),
      /rin_managed_service_unsupported/,
    );
  } finally {
    await fs.rm(path.dirname(sandbox.home), { recursive: true, force: true });
  }
});

test("managed runtime systemd actions normalize start and fail closed", () => {
  const { context, events } = actionContext(os.tmpdir());
  const service = { kind: "systemd", label: "owner.service" } as const;
  assert.equal(
    managed.runManagedSystemdServiceAction(context, service, "start"),
    "owner.service",
  );
  assert.equal(
    managed.runManagedSystemdServiceAction(context, service, "stop"),
    "owner.service",
  );
  assert.ok(
    events.some(
      (event) =>
        event[0] === "exec" && JSON.stringify(event).includes("restart"),
    ),
  );
  assert.throws(
    () =>
      managed.runManagedSystemdServiceAction(
        { ...context, systemctl: "" },
        service,
        "restart",
      ),
    /rin_managed_service_unsupported:systemd/,
  );
  assert.throws(
    () =>
      managed.runManagedSystemdServiceAction(
        {
          ...context,
          exec() {
            throw new Error("owner systemd failure");
          },
        },
        service,
        "restart",
      ),
    /rin_managed_service_action_failed/,
  );
});

test("managed runtime launchd covers bootstrap, kickstart, bootout, and stop fencing", async () => {
  const sandbox = await createTestSandbox("managed-runtime-launchd-owner");
  try {
    const servicePath = path.join(path.dirname(sandbox.home), "owner.plist");
    await fs.writeFile(servicePath, "owner", "utf8");
    const service = {
      kind: "launchd",
      label: "com.owner.rin",
      path: servicePath,
    } as const;
    const first = actionContext(path.dirname(sandbox.home));
    assert.equal(
      await managed.runManagedLaunchdServiceAction(
        first.context,
        service,
        "start",
        { resolveDomain: () => "gui/501" },
      ),
      service.label,
    );
    assert.ok(JSON.stringify(first.events).includes("bootstrap"));

    let bootstrapFailed = false;
    const second = actionContext(path.dirname(sandbox.home), {
      capture(argv: string[]) {
        if (argv.includes("bootstrap")) {
          bootstrapFailed = true;
          throw new Error("bootstrap failed");
        }
        return "";
      },
    });
    await managed.runManagedLaunchdServiceAction(
      second.context,
      service,
      "start",
      { resolveDomain: () => "gui/501" },
    );
    assert.equal(bootstrapFailed, true);
    assert.ok(JSON.stringify(second.events).includes("kickstart"));

    for (const action of ["stop", "restart"] as const) {
      const stopped = actionContext(path.dirname(sandbox.home));
      assert.equal(
        await managed.runManagedLaunchdServiceAction(
          stopped.context,
          service,
          action,
          {
            resolveDomain: () => "gui/501",
            waitForDaemonUnavailable: async () => true,
          },
        ),
        service.label,
      );
    }
    for (const action of ["stop", "restart"] as const) {
      const defaultWait = actionContext(path.dirname(sandbox.home));
      assert.equal(
        await managed.runManagedLaunchdServiceAction(
          defaultWait.context,
          service,
          action,
          { resolveDomain: () => "gui/501" },
        ),
        service.label,
      );
    }

    const incomplete = actionContext(path.dirname(sandbox.home));
    await assert.rejects(
      () =>
        managed.runManagedLaunchdServiceAction(
          incomplete.context,
          service,
          "stop",
          {
            resolveDomain: () => "gui/501",
            waitForDaemonUnavailable: async () => false,
          },
        ),
      /rin_launchd_daemon_stop_incomplete/,
    );

    const noBootout = actionContext(path.dirname(sandbox.home), {
      capture(argv: string[]) {
        if (argv.includes("bootout")) throw new Error("missing bootout");
        return "";
      },
      async canConnectSocket() {
        return true;
      },
    });
    await assert.rejects(
      () =>
        managed.runManagedLaunchdServiceAction(
          noBootout.context,
          service,
          "restart",
          { resolveDomain: () => "gui/501" },
        ),
      /rin_launchd_daemon_stop_incomplete/,
    );
    const alreadyStopped = actionContext(path.dirname(sandbox.home), {
      capture() {
        throw new Error("not loaded");
      },
      async canConnectSocket() {
        return false;
      },
    });
    assert.equal(
      await managed.runManagedLaunchdServiceAction(
        alreadyStopped.context,
        service,
        "stop",
        { resolveDomain: () => "gui/501" },
      ),
      service.label,
    );
    await assert.rejects(
      () =>
        managed.runManagedLaunchdServiceAction(
          first.context,
          { ...service, path: undefined } as any,
          "start",
        ),
      /rin_managed_service_missing_path/,
    );

    const currentUser = os.userInfo();
    const defaultDomain = actionContext(path.dirname(sandbox.home), {
      targetUser: currentUser.username,
    });
    assert.equal(
      await managed.runManagedLaunchdServiceAction(
        defaultDomain.context,
        service,
        "start",
      ),
      service.label,
    );
    assert.equal(
      managed.__rinOwnerLaunchdDomainForTargetUser(currentUser.username),
      `gui/${currentUser.uid}`,
    );
    assert.throws(
      () =>
        managed.__rinOwnerLaunchdDomainForTargetUser(
          "rin-owner-missing-system-user",
        ),
      /rin_launchd_target_user_not_found/,
    );
  } finally {
    await fs.rm(path.dirname(sandbox.home), { recursive: true, force: true });
  }
});

test("managed runtime private helpers cover launchd target fallbacks and daemon waits", async () => {
  const sandbox = await createTestSandbox("managed-runtime-private-owner");
  try {
    const service = {
      kind: "launchd",
      label: "com.owner.rin",
      path: path.join(path.dirname(sandbox.home), "owner.plist"),
    } as const;
    const successful = actionContext(path.dirname(sandbox.home));
    assert.equal(
      managed.__rinOwnerTryBootoutLaunchd(
        successful.context,
        "gui/501",
        service,
      ),
      true,
    );
    const fallback = actionContext(path.dirname(sandbox.home), {
      capture(argv: string[]) {
        if (String(argv[2]).includes(service.label)) {
          throw new Error("label missing");
        }
        return "";
      },
    });
    assert.equal(
      managed.__rinOwnerTryBootoutLaunchd(fallback.context, "gui/501", service),
      true,
    );
    const failed = actionContext(path.dirname(sandbox.home), {
      capture() {
        throw new Error("all missing");
      },
    });
    assert.equal(
      managed.__rinOwnerTryBootoutLaunchd(failed.context, "gui/501", service),
      false,
    );

    assert.equal(
      managed.__rinOwnerStopWindowsDaemonFromLock(
        path.join(path.dirname(sandbox.home), "no-agent"),
      ),
      false,
    );
    let connectChecks = 0;
    const waiting = actionContext(path.dirname(sandbox.home), {
      async canConnectSocket() {
        connectChecks += 1;
        return connectChecks < 2;
      },
    });
    assert.equal(
      await managed.__rinOwnerWaitForDaemonUnavailable(waiting.context, 500),
      true,
    );
    const connected = actionContext(path.dirname(sandbox.home), {
      async canConnectSocket() {
        return true;
      },
    });
    assert.equal(
      await managed.__rinOwnerWaitForDaemonUnavailable(connected.context, 0),
      false,
    );
  } finally {
    await fs.rm(path.dirname(sandbox.home), { recursive: true, force: true });
  }
});

test("managed runtime context and platform dispatch expose safe defaults", async () => {
  const sandbox = await createTestSandbox("managed-runtime-context-owner");
  try {
    const context = managed.createManagedRuntimeServiceActionContext({
      targetUser: os.userInfo().username,
      currentUser: os.userInfo().username,
      installDir: path.join(path.dirname(sandbox.home), "install"),
    });
    assert.equal(context.isTargetUser, true);
    assert.ok(context.agentDir);
    assert.equal(typeof context.exec, "function");
    assert.equal(typeof context.capture, "function");
    assert.equal(typeof context.canConnectSocket, "function");

    const { context: launchd } = actionContext(path.dirname(sandbox.home), {
      targetPathExists: () => true,
    });
    await assert.rejects(
      () =>
        managed.tryManagedServiceAction(launchd, "start", {
          kind: "launchd",
          label: "owner",
        }),
      /rin_managed_service_unsupported:launchd/,
    );
    await assert.rejects(
      () =>
        managed.tryManagedServiceAction(launchd, "start", {
          kind: "windows-startup",
          label: "owner",
        }),
      /rin_managed_service_unsupported:windows-startup/,
    );
  } finally {
    await fs.rm(path.dirname(sandbox.home), { recursive: true, force: true });
  }
});

test("managed runtime context executes injected filesystem and process boundaries", async () => {
  const sandbox = await createTestSandbox("managed-runtime-boundaries-owner");
  const root = path.dirname(sandbox.home);
  try {
    const installDir = path.join(root, "install");
    const targetUser = os.userInfo().username;
    const context = managed.createManagedRuntimeServiceActionContext({
      installDir,
      targetUser,
      currentUser: targetUser,
    });
    context.exec([process.execPath, "-e", "process.exit(0)"]);
    assert.equal(
      context.capture([
        process.execPath,
        "-e",
        "process.stdout.write('owner')",
      ]),
      "owner",
    );
    assert.equal(await context.canConnectSocket(), false);

    const remote = actionContext(root, {
      currentUser: "current",
      targetUser: "owner",
      isTargetUser: false,
    });
    let attempts = 0;
    remote.context.exec = (argv: string[]) => {
      attempts += 1;
      remote.events.push(["remote-exec", argv]);
    };
    assert.equal(
      managed.runManagedSystemdServiceAction(
        remote.context,
        { kind: "systemd", label: "owner.service" },
        "restart",
      ),
      "owner.service",
    );
    assert.ok(attempts >= 1);
    assert.equal(
      await managed.tryManagedServiceAction(remote.context, "restart", {
        kind: "systemd",
        label: "owner.service",
      }),
      "owner.service",
    );
    remote.context.readJson = () => ({
      service: { kind: "systemd", label: "owner.service" },
    });
    remote.context.readPrivilegedJson = remote.context.readJson;
    assert.equal(
      await managed.tryManagedServiceAction(remote.context, "start"),
      "owner.service",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("managed runtime private Windows stop helper fences the owned daemon process", async (t) => {
  const sandbox = await createTestSandbox("managed-runtime-windows-stop-owner");
  const root = path.dirname(sandbox.home);
  try {
    const lockModule = await import(
      pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "lock.js"))
        .href
    );
    const agentDir = path.join(root, "agent");
    const acquired = await lockModule.acquireDaemonInstanceLock(agentDir, {
      socketPath: path.join(root, "daemon.sock"),
    });
    let terminated = false;
    let sigtermMissing = false;
    t.mock.method(process, "kill", ((pid: number, signal?: any) => {
      assert.equal(pid, process.pid);
      if (signal === "SIGTERM") {
        if (sigtermMissing) {
          const error: NodeJS.ErrnoException = new Error("gone");
          error.code = "ESRCH";
          throw error;
        }
        terminated = true;
        return true;
      }
      if (signal === 0 && terminated) {
        const error: NodeJS.ErrnoException = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill);
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    Object.defineProperty(process, "platform", { value: "win32" });
    t.after(() => {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    });
    const windows = actionContext(root, {
      agentDir,
      isTargetUser: true,
      async canConnectSocket() {
        return false;
      },
    });
    assert.equal(
      await managed.__rinOwnerTryManagedWindowsStartupAction(
        windows.context,
        { kind: "windows-startup", label: "owner-startup" },
        "stop",
      ),
      "owner-startup",
    );
    assert.equal(terminated, true);
    sigtermMissing = true;
    assert.equal(managed.__rinOwnerStopWindowsDaemonFromLock(agentDir), false);
    sigtermMissing = false;
    await assert.rejects(
      () =>
        managed.__rinOwnerTryManagedWindowsStartupAction(
          { ...windows.context, isTargetUser: false },
          { kind: "windows-startup", label: "owner-startup" },
          "stop",
        ),
      /rin_windows_daemon_cross_user_unsupported/,
    );
    await acquired.release();

    await assert.rejects(
      () =>
        managed.__rinOwnerTryManagedWindowsStartupAction(
          {
            ...windows.context,
            async canConnectSocket() {
              return true;
            },
          },
          { kind: "windows-startup", label: "owner-startup" },
          "restart",
        ),
      /rin_windows_daemon_pid_missing/,
    );
    assert.equal(
      await managed.__rinOwnerTryManagedWindowsStartupAction(
        {
          ...windows.context,
          async canConnectSocket() {
            return true;
          },
        },
        { kind: "windows-startup", label: "owner-startup" },
        "start",
      ),
      "owner-startup",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
