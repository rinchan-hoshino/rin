import { getPiBuiltInExtensions } from "../pi/private-api.js";

export async function withRinPiExtensionFactories<T>(
  options: T,
): Promise<T & { extensionFactories: unknown[] }> {
  const extensionFactories = Array.isArray((options as any)?.extensionFactories)
    ? (options as any).extensionFactories
    : [];
  return {
    ...(options as any),
    extensionFactories: [
      ...(await getPiBuiltInExtensions()),
      ...extensionFactories,
    ],
  };
}
