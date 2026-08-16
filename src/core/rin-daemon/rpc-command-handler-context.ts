export type RpcCommand = Record<string, any>;

export type RpcCommandRequest = {
  command: RpcCommand;
  id: string | undefined;
  type: string;
};

export type RpcDone = (
  id: string | undefined,
  type: string,
  value?: unknown,
) => unknown;

export type RpcRun = (
  id: string | undefined,
  type: string,
  task: () => any,
  project?: (value: any) => any,
) => Promise<unknown>;

export type RpcInjectedFunction = (...args: any[]) => any;
