import type { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
export declare function createRelay(opts?: { server?: Server; port?: number; path?: string; dataFile?: string }): {
  wss: WebSocketServer;
  size: () => number;
  close: () => Promise<void>;
};
