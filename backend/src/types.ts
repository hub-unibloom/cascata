import { Request } from 'express';
import pg from 'pg';
import { IncomingHttpHeaders } from 'http';
import { Socket } from 'net';

export interface CascataRequest extends Request {
  // --- Cascata Custom Properties ---
  project?: any;
  projectPool?: pg.Pool;
  user?: any;
  userRole?: 'service_role' | 'authenticated' | 'anon';
  appClient?: any;
  isSystemRequest?: boolean;
  file?: any;
  files?: any;

  // Explicitly define properties to resolve TypeScript errors in controllers
  // These MUST match Express Request's signatures (no weaker optionality)
  body: any;
  params: any;
  query: any;
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
  url: string;
  ip: string;
  socket: Socket;
  on: (event: string, listener: (...args: any[]) => void) => this;
}