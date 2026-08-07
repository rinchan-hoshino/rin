import { registerHooks } from "node:module";

const source = `
export async function startUpdatePayload() {
  if (process.env.RIN_TEST_UPDATE_PAYLOAD_FAILURE === "string") {
    throw "owner payload failure";
  }
  if (process.env.RIN_TEST_UPDATE_PAYLOAD_FAILURE === "error") {
    throw new Error("owner error failure");
  }
  if (process.env.RIN_TEST_UPDATE_PAYLOAD_FAILURE === "empty") {
    throw "";
  }
  console.log("owner payload started");
}
`;
const fixtureUrl = `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith("/dist/core/rin-install/update-payload.js") ||
      specifier === "../../core/rin-install/update-payload.js"
    ) {
      return { shortCircuit: true, url: fixtureUrl };
    }
    return nextResolve(specifier, context);
  },
});
