import fs from "node:fs";
import path from "node:path";

export type StagedTestPlan = {
  fullGate: boolean;
  architecture: boolean;
  unitOwnerTests: string[];
  nonUnitOwnerSources: string[];
  directTests: string[];
};

type UnitCatalog = {
  modules: Array<{ source: string; test: string }>;
};

type NonUnitCatalog = {
  modules: Array<{ source: string; tests: string[] }>;
};

const normalize = (value: string) => value.split(path.sep).join("/");

function uniqueSorted(values: Iterable<string>) {
  return [...new Set(values)].sort();
}

export function createStagedTestPlan(
  stagedFiles: string[],
  rootDir = process.cwd(),
): StagedTestPlan {
  const files = uniqueSorted(stagedFiles.map(normalize).filter(Boolean));
  const fullGate = files.some((file) =>
    /^(?:package(?:-lock)?\.json|tsconfig.*\.json|eslint\.config\.ts|scripts\/build\.ts|scripts\/test\/run-coverage\.ts|tests\/(?:unit\/catalog|non-unit\/catalog|coverage-policy|characterization\/baseline|characterization\/catalog|mutation|torture)\.json)/.test(
      file,
    ),
  );
  if (fullGate) {
    return {
      fullGate: true,
      architecture: true,
      unitOwnerTests: [],
      nonUnitOwnerSources: [],
      directTests: [],
    };
  }

  const unit = JSON.parse(
    fs.readFileSync(path.join(rootDir, "tests/unit/catalog.json"), "utf8"),
  ) as UnitCatalog;
  const nonUnit = JSON.parse(
    fs.readFileSync(path.join(rootDir, "tests/non-unit/catalog.json"), "utf8"),
  ) as NonUnitCatalog;
  const fileSet = new Set(files);
  const changedTests = files.filter((file) =>
    /^tests\/.*\.test\.ts$/.test(file),
  );

  return {
    fullGate: false,
    architecture: files.some((file) =>
      /^(?:tests\/architecture\/|scripts\/test\/|\.ci\/|\.githooks\/)/.test(
        file,
      ),
    ),
    unitOwnerTests: uniqueSorted(
      unit.modules
        .filter((entry) => fileSet.has(entry.source) || fileSet.has(entry.test))
        .map((entry) => entry.test),
    ),
    nonUnitOwnerSources: uniqueSorted(
      nonUnit.modules
        .filter(
          (entry) =>
            fileSet.has(entry.source) ||
            entry.tests.some((test) => fileSet.has(test)),
        )
        .map((entry) => entry.source),
    ),
    directTests: uniqueSorted(
      changedTests.filter(
        (test) =>
          !unit.modules.some((entry) => entry.test === test) &&
          !nonUnit.modules.some((entry) => entry.tests.includes(test)),
      ),
    ),
  };
}
