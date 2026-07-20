import { File as NodeFile } from "node:buffer";

import {
  Agent as UndiciAgent,
  fetch as undiciFetch,
  FormData as UndiciFormData,
  Headers as UndiciHeaders,
  type Dispatcher,
} from "undici";

export type RinHttpFetch = (
  input: Parameters<typeof undiciFetch>[0],
  init?: any,
) => ReturnType<typeof undiciFetch>;

export type RinHttpTransport = {
  fetch: RinHttpFetch;
  close: () => Promise<void>;
};

export async function discardRinHttpResponseBody(response: any) {
  try {
    await response?.body?.cancel?.();
  } catch {}
}

function isFormDataBody(value: any) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.entries === "function" &&
    Object.prototype.toString.call(value) === "[object FormData]",
  );
}

async function reconstructRequestFormData(body: any) {
  const isolated = new UndiciFormData();
  for (const [name, value] of body.entries()) {
    if (typeof value === "string") {
      isolated.append(name, value);
      continue;
    }
    const rawFileName = value?.name;
    const fileName =
      typeof rawFileName === "string" && rawFileName ? rawFileName : "blob";
    isolated.append(
      name,
      new NodeFile([new Uint8Array(await value.arrayBuffer())], fileName, {
        type: value.type,
      }) as any,
      fileName,
    );
  }
  return isolated;
}

function headersForReconstructedFormData(headers: any) {
  const isolated = new UndiciHeaders(headers);
  if (
    /^multipart\/form-data(?:;|$)/i.test(isolated.get("content-type") || "")
  ) {
    isolated.delete("content-type");
  }
  return isolated;
}

export function createRinHttpTransport(
  options: {
    dispatcher?: Dispatcher;
    agentOptions?: ConstructorParameters<typeof UndiciAgent>[0];
    reconstructFormData?: boolean;
  } = {},
): RinHttpTransport {
  const dispatcher =
    options.dispatcher || new UndiciAgent(options.agentOptions || {});
  let closed = false;
  return {
    fetch: async (input, init = {}) => {
      const shouldReconstructFormData =
        options.reconstructFormData === true && isFormDataBody(init?.body);
      return await undiciFetch(input, {
        ...init,
        headers: shouldReconstructFormData
          ? headersForReconstructedFormData(init?.headers)
          : init?.headers,
        body: shouldReconstructFormData
          ? await reconstructRequestFormData(init.body)
          : init?.body,
        dispatcher,
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await dispatcher.close();
    },
  };
}
