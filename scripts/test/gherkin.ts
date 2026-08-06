import fs from "node:fs";
import path from "node:path";

export type GherkinStep = {
  keyword: "Given" | "When" | "Then" | "And" | "But";
  text: string;
  line: number;
};

export type GherkinScenario = {
  name: string;
  line: number;
  steps: GherkinStep[];
};

export type GherkinFeature = {
  name: string;
  background: GherkinStep[];
  scenarios: GherkinScenario[];
};

export type GherkinStepDefinition<World> = {
  pattern: RegExp;
  run: (world: World, ...captures: string[]) => unknown | Promise<unknown>;
};

function parseStep(line: string, lineNumber: number): GherkinStep | null {
  const match = /^(Given|When|Then|And|But)\s+(.+)$/.exec(line);
  if (!match) return null;
  return {
    keyword: match[1] as GherkinStep["keyword"],
    text: match[2].trim(),
    line: lineNumber,
  };
}

export function parseGherkinFeature(source: string): GherkinFeature {
  let featureName = "";
  let background: GherkinStep[] | null = null;
  let currentScenario: GherkinScenario | null = null;
  const scenarios: GherkinScenario[] = [];

  for (const [index, rawLine] of String(source).split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("@")) continue;
    if (line.startsWith("Feature:")) {
      if (featureName)
        throw new Error(`gherkin_duplicate_feature:${lineNumber}`);
      featureName = line.slice("Feature:".length).trim();
      if (!featureName)
        throw new Error(`gherkin_feature_name_required:${lineNumber}`);
      continue;
    }
    if (line.startsWith("Rule:")) continue;
    if (line === "Background:" || line.startsWith("Background:")) {
      if (!featureName)
        throw new Error(`gherkin_background_before_feature:${lineNumber}`);
      if (background)
        throw new Error(`gherkin_duplicate_background:${lineNumber}`);
      background = [];
      currentScenario = null;
      continue;
    }
    if (line.startsWith("Scenario Outline:") || line.startsWith("Examples:")) {
      throw new Error(`gherkin_outline_not_supported:${lineNumber}`);
    }
    if (line.startsWith("Scenario:")) {
      const name = line.slice("Scenario:".length).trim();
      if (!featureName)
        throw new Error(`gherkin_scenario_before_feature:${lineNumber}`);
      if (!name)
        throw new Error(`gherkin_scenario_name_required:${lineNumber}`);
      currentScenario = { name, line: lineNumber, steps: [] };
      scenarios.push(currentScenario);
      continue;
    }
    const step = parseStep(line, lineNumber);
    if (step) {
      if (currentScenario) currentScenario.steps.push(step);
      else if (background) background.push(step);
      else throw new Error(`gherkin_step_without_scenario:${lineNumber}`);
      continue;
    }
    if (!currentScenario && background === null) continue;
    throw new Error(`gherkin_unknown_statement:${lineNumber}:${line}`);
  }

  if (!featureName) throw new Error("gherkin_feature_required");
  if (!scenarios.length) throw new Error("gherkin_scenario_required");
  for (const scenario of scenarios) {
    if (!scenario.steps.length) {
      throw new Error(`gherkin_scenario_steps_required:${scenario.line}`);
    }
  }
  return { name: featureName, background: background || [], scenarios };
}

export function loadGherkinFeature(filePath: string): GherkinFeature {
  return parseGherkinFeature(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function matchingDefinition<World>(
  definitions: readonly GherkinStepDefinition<World>[],
  step: GherkinStep,
) {
  const matches = definitions.flatMap((definition) => {
    definition.pattern.lastIndex = 0;
    const match = definition.pattern.exec(step.text);
    return match ? [{ definition, captures: match.slice(1) }] : [];
  });
  if (!matches.length)
    throw new Error(`gherkin_step_undefined:${step.line}:${step.text}`);
  if (matches.length > 1)
    throw new Error(`gherkin_step_ambiguous:${step.line}:${step.text}`);
  return matches[0];
}

export async function runGherkinScenario<World>(options: {
  feature: GherkinFeature;
  scenario: GherkinScenario;
  world: World;
  definitions: readonly GherkinStepDefinition<World>[];
}) {
  for (const step of [
    ...options.feature.background,
    ...options.scenario.steps,
  ]) {
    const match = matchingDefinition(options.definitions, step);
    try {
      await match.definition.run(options.world, ...match.captures);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `gherkin_step_failed:${step.line}:${step.keyword} ${step.text}:${message}`,
        {
          cause: error,
        },
      );
    }
  }
}
