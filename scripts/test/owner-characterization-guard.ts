import * as moduleApi from "node:module";

export function isCharacterizationModuleUrl(url: string): boolean {
  return url.replaceAll("\\", "/").includes("/tests/characterization/");
}

function rejectCharacterizationModule(url: string) {
  if (isCharacterizationModuleUrl(url)) {
    throw new Error(`strict_owner_characterization_import_forbidden:${url}`);
  }
}

const registerHooks = (moduleApi as any).registerHooks as
  | ((hooks: {
      resolve(
        specifier: string,
        context: unknown,
        nextResolve: (specifier: string, context: unknown) => { url: string },
      ): { url: string };
    }) => unknown)
  | undefined;

if (registerHooks) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      rejectCharacterizationModule(resolved.url);
      return resolved;
    },
  });
} else {
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
  moduleApi.register(
    `data:text/javascript,${encodeURIComponent(hookSource)}`,
    import.meta.url,
  );
}
