import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGherkinFeature,
  runGherkinScenario,
} from "../../scripts/test/gherkin.js";

test("Gherkin runner parses background and executes uniquely owned steps", async () => {
  const feature = parseGherkinFeature(`
Feature: Owner contract
  Background:
    Given an empty count
  Scenario: Increment once
    When the count is incremented
    Then the count is 1
`);
  const world = { count: -1 };
  await runGherkinScenario({
    feature,
    scenario: feature.scenarios[0],
    world,
    definitions: [
      {
        pattern: /^an empty count$/,
        run: (state) => {
          state.count = 0;
        },
      },
      {
        pattern: /^the count is incremented$/,
        run: (state) => {
          state.count += 1;
        },
      },
      {
        pattern: /^the count is (\d+)$/,
        run: (state, value) => assert.equal(state.count, Number(value)),
      },
    ],
  });
  assert.equal(world.count, 1);
});

test("Gherkin runner rejects undefined, ambiguous, and unsupported outline contracts", async () => {
  const feature = parseGherkinFeature(`
Feature: Missing owner
  Scenario: Undefined step
    Given no owner
`);
  await assert.rejects(
    runGherkinScenario({
      feature,
      scenario: feature.scenarios[0],
      world: {},
      definitions: [],
    }),
    /gherkin_step_undefined/,
  );
  await assert.rejects(
    runGherkinScenario({
      feature,
      scenario: feature.scenarios[0],
      world: {},
      definitions: [
        { pattern: /no owner/, run() {} },
        { pattern: /^no owner$/, run() {} },
      ],
    }),
    /gherkin_step_ambiguous/,
  );
  assert.throws(
    () =>
      parseGherkinFeature("Feature: Outline\nScenario Outline: Unsupported"),
    /gherkin_outline_not_supported/,
  );
});
