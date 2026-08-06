import { register } from "node:module";

const replacements: Record<string, string> = {
  "dist/core/session/factory.js": `
    export async function openBoundSession(options) {
      const fixture = globalThis.__rinSessionRunnerFixture;
      fixture.openOptions = options;
      return fixture.bound;
    }
  `,
  "dist/core/session/metadata.js": `
    export function readSessionMetadata() {
      return globalThis.__rinSessionRunnerFixture.metadata;
    }
  `,
};

const replacementUrls = Object.fromEntries(
  Object.entries(replacements).map(([target, source]) => [
    target,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hookSource = `
const replacements = ${JSON.stringify(replacementUrls)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const target = Object.keys(replacements).find((suffix) =>
    resolved.url.endsWith(suffix),
  );
  if (target) {
    return { url: replacements[target], shortCircuit: true };
  }
  return resolved;
}
`;

register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
