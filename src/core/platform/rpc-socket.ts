import { EventEmitter } from "node:events";

export interface RpcSocketLike extends EventEmitter {
  destroyed: boolean;
  write(chunk: string): boolean;
  end(): void;
  destroy(error?: Error): void;
}

export type RpcSocketConnector = () => RpcSocketLike | Promise<RpcSocketLike>;

class InMemoryRpcSocket extends EventEmitter implements RpcSocketLike {
  destroyed = false;
  private peer: InMemoryRpcSocket | null = null;

  attachPeer(peer: InMemoryRpcSocket) {
    this.peer = peer;
  }

  write(chunk: string) {
    if (this.destroyed) return false;
    const peer = this.peer;
    if (!peer || peer.destroyed) return false;
    queueMicrotask(() => {
      if (peer.destroyed) return;
      peer.emit("data", chunk);
    });
    return true;
  }

  end() {
    this.close();
  }

  destroy(error?: Error) {
    this.close(error);
  }

  private close(error?: Error) {
    if (this.destroyed) return;
    this.destroyed = true;
    const peer = this.peer;
    this.peer = null;
    queueMicrotask(() => {
      if (error) this.emit("error", error);
      this.emit("close");
    });
    if (peer && !peer.destroyed) {
      peer.closeFromPeer();
    }
  }

  private closeFromPeer() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.peer = null;
    queueMicrotask(() => {
      this.emit("close");
    });
  }
}

export function createConnectedRpcSocketPair() {
  const clientSocket = new InMemoryRpcSocket();
  const serverSocket = new InMemoryRpcSocket();
  clientSocket.attachPeer(serverSocket);
  serverSocket.attachPeer(clientSocket);
  setTimeout(() => {
    if (!clientSocket.destroyed) clientSocket.emit("connect");
    if (!serverSocket.destroyed) serverSocket.emit("connect");
  }, 0);
  return { clientSocket, serverSocket };
}
