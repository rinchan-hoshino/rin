import test from "node:test";
import assert from "node:assert/strict";

import { runManagedSystemdServiceAction } from "../../dist/core/rin/managed-runtime-service.js";

test("systemd restart does not use active-only status as a unit existence probe", () => {
  const captured = [];
  const executed = [];
  const context = {
    currentUser: "rin",
    targetUser: "rin",
    elevated: false,
    systemctl: "/usr/bin/systemctl",
    capture(command) {
      captured.push(command);
      return "";
    },
    exec(command) {
      executed.push(command);
      return "";
    },
  };
  const service = {
    kind: "systemd",
    label: "rin-daemon-rin.service",
    servicePath: "/home/rin/.config/systemd/user/rin-daemon-rin.service",
  };

  const result = runManagedSystemdServiceAction(context, service, "restart");

  assert.equal(result, service.label);
  assert.deepEqual(captured, [
    ["/usr/bin/systemctl", "--user", "daemon-reload"],
  ]);
  assert.deepEqual(executed, [
    ["/usr/bin/systemctl", "--user", "restart", "rin-daemon-rin.service"],
  ]);
});
