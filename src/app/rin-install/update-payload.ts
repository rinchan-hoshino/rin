#!/usr/bin/env node
import { startUpdatePayload } from "../../core/rin-install/update-payload.js";
import { formatRuntimeErrorForUser } from "../../core/presentation/error.js";

startUpdatePayload().catch((error: any) => {
  console.error(
    formatRuntimeErrorForUser(error || "rin_update_payload_failed"),
  );
  process.exit(1);
});
