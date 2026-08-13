import fs from "node:fs";

import { createStagedTestPlan } from "./staged-test-plan.js";

const files = fs
  .readFileSync(0, "utf8")
  .split("\0")
  .map((file) => file.trim())
  .filter(Boolean);
const plan = createStagedTestPlan(files);

console.log(plan.fullGate ? "full" : "focused");
console.log(plan.unitOwnerTests.join(" "));
console.log(plan.nonUnitOwnerSources.join(" "));
console.log(plan.directTests.join(" "));
console.log(plan.architecture ? "architecture" : "");
