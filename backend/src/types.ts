import { Request } from 'express';
import pg from 'pg';
import { IncomingHttpHeaders } from 'http';

export interface CascataRequest extends Request {
  project?: any;
  projectPool?: pg.Pool;
  user?: any;
  userRole?: 'service_role' | 'authenticated' | 'anon';
  isSystemRequest?: boolean;
  file?: any;
  files?: any;

  // Explicitly define properties to resolve TypeScript errors in controllers
  // These properties are normally inherited from Request but are explicitly added here to ensure compatibility
  body: any;
  params: any;
  query: any;
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
  url: string;
  socket: any;
  on: (event: string, listener: (...args: any[]) => void) => this;
}