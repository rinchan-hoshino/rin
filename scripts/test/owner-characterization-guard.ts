import { register } from "node:module";

export function isCharacterizationModuleUrl(url: string): boolean {
  return url.replaceAll("\\", "/").includes("/tests/characterization/");
}

const hookSource = `
  const forbidden = "/tests/characterization/";
  export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context);
    if (resolved.url.replaceAll("\\\\", "/").includes(forbidden)) {
      throw new Error("strict_owner_characterization_import_forbidden:" + resolved.url);
    }
    return resolved;
  }
`;

register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
