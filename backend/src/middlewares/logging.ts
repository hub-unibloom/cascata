
import { RequestHandler } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool } from '../config/main.js';
import { WebhookService } from '../../services/WebhookService.js';
import { SystemLogService } from '../../services/SystemLogService.js';
import { Buffer } from 'buffer';

export const detectSemanticAction = (method: string, path: string): string | null => {
    if (path.includes('/tables') && method === 'POST' && path.endsWith('/rows')) return 'INSERT_ROWS';
    if (path.includes('/tables') && method === 'POST') return 'CREATE_TABLE';
    if (path.includes('/tables') && method === 'DELETE' && !path.includes('/rows')) return 'DROP_TABLE';
    if (path.includes('/tables') && method === 'DELETE' && path.includes('/rows')) return 'DELETE_ROWS';
    if (path.includes('/tables') && method === 'PUT') return 'UPDATE_ROWS';
    if (path.includes('/rest/v1/') && method === 'GET') return 'REST_SELECT';
    if (path.includes('/rest/v1/') && method === 'POST') return 'REST_INSERT';
    if (path.includes('/rest/v1/') && method === 'PATCH') return 'REST_UPDATE';
    if (path.includes('/rest/v1/') && method === 'DELETE') return 'REST_DELETE';
    if (path.includes('/auth/token') && !path.includes('refresh')) return 'AUTH_LOGIN';
    if (path.includes('/auth/token/refresh')) return 'AUTH_REFRESH';
    if (path.includes('/auth/callback')) return 'AUTH_CALLBACK'; 
    if (path.includes('/auth/passwordless/start')) return 'AUTH_OTP_REQUEST'; 
    if (path.includes('/auth/passwordless/verify')) return 'AUTH_OTP_VERIFY'; 
    if (path.includes('/auth/users') && method === 'POST') return 'AUTH_REGISTER';
    if (path.includes('/storage') && method === 'POST' && path.includes('/upload')) return 'UPLOAD_FILE';
    if (path.includes('/storage') && method === 'DELETE') return 'DELETE_FILE';
    if (path.includes('/edge/')) return 'EDGE_INVOKE';
    
    if (path.includes('/auth/v1/signup')) return 'GOTRUE_SIGNUP';
    if (path.includes('/auth/v1/token')) return 'GOTRUE_TOKEN';
    if (path.includes('/auth/v1/user')) return 'GOTRUE_USER';
    if (path.includes('/auth/v1/authorize')) return 'GOTRUE_OAUTH_START';
    if (path.includes('/auth/v1/callback')) return 'GOTRUE_OAUTH_CALLBACK';
    if (path.includes('/auth/v1/verify')) return 'GOTRUE_VERIFY_EMAIL';
    
    return null;
};

// HELPER: PII Scrubbing
const SENSITIVE_KEYS = ['password', 'token', 'secret', 'key', 'access_token', 'refresh_token', 'authorization', 'api_key', 'apikey'];

const scrubPayload = (obj: any): any => {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(scrubPayload);
    
    const scrubbed: any = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const lowerKey = key.toLowerCase();
            if (SENSITIVE_KEYS.some(k => lowerKey.includes(k))) {
                scrubbed[key] = '***REDACTED***';
            } else {
                scrubbed[key] = scrubPayload(obj[key]);
            }
        }
    }
    return scrubbed;
};

// Safe Stringify Implementation
const safeStringify = (obj: any, limit: number = 2000): string => {
    try {
        const cache = new Set();
        const cleaned = scrubPayload(obj);
        
        const str = JSON.stringify(cleaned, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (cache.has(value)) return;
                cache.add(value);
            }
            return value;
        });
        
        if (str.length > limit) {
            return str.substring(0, limit) + '... [TRUNCATED]';
        }
        return str;
    } catch (e) {
        return '[Unserializable Payload]';
    }
};

export const auditLogger: RequestHandler = (req: any, res: any, next: any) => {
  const start = Date.now();
  const oldJson = res.json;
  const oldWrite = res.write;
  const oldEnd = res.end;
  const r = req as CascataRequest;
  
  // Track response size
  let responseSize = 0;

  if (req.path.includes('/realtime')) return next();

  // Hook write to count bytes
  res.write = function (chunk: any, ...args: any[]) {
      if (chunk) responseSize += Buffer.byteLength(chunk);
      return oldWrite.apply(res, [chunk, ...args]);
  };

  // Hook end to count bytes and finalize log
  res.end = function (chunk: any, ...args: any[]) {
      if (chunk) responseSize += Buffer.byteLength(chunk);
      return oldEnd.apply(res, [chunk, ...args]);
  };

  // Hook json to capture body for webhook (legacy support)
  (res as any).json = function(data: any) {
    // We defer the logging to 'finish' event to ensure size is calculated correctly from all streams
    // But we need to capture data for webhook here
    if (r.project && res.statusCode >= 200 && res.statusCode < 300 && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
         let tableName = '*';
         if (req.path.includes('/tables/')) { 
             const parts = req.path.split('/tables/'); 
             if (parts[1]) tableName = parts[1].split('/')[0]; 
         } else if (req.path.includes('/rest/v1/')) {
             const parts = req.path.split('/rest/v1/'); 
             if (parts[1]) tableName = parts[1].split('/')[0];
         }
         
         const semanticAction = detectSemanticAction(req.method, req.path);
         WebhookService.dispatch(
             r.project.slug, 
             tableName, 
             semanticAction || req.method, 
             data, 
             systemPool, 
             r.project.jwt_secret
         ).catch(e => console.error("Webhook Dispatch Error", e));
    }
    return oldJson.apply(res, arguments as any);
  };

  // Finalize Log on Response Finish
  res.on('finish', () => {
      if (r.project) {
        const duration = Date.now() - start;
        const forwarded = req.headers['x-forwarded-for'];
        const realIp = req.headers['x-real-ip'];
        const socketIp = (req as any).socket?.remoteAddress;
        let clientIp = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
        clientIp = clientIp.replace('::ffff:', '');
        const isInternal = req.headers['x-cascata-client'] === 'dashboard' || r.isSystemRequest;
        const semanticAction = detectSemanticAction(req.method, req.path);
        const geoInfo = { is_internal: isInternal, auth_status: res.statusCode >= 400 ? 'SECURITY_ALERT' : 'GRANTED', semantic_action: semanticAction };

        // Request Payload Size Check
        const isUpload = req.headers['content-type']?.includes('multipart/form-data');
        let inputPayload: any = {};
        const contentLength = parseInt(req.headers['content-length'] || '0');
        
        if (contentLength > 50000) { 
            inputPayload = { type: 'large_payload_truncated', size: contentLength };
        } else {
            // Body might be consumed already, be careful accessing req.body
            // VULNERABILITY FIX: Scrub payload before logging
            inputPayload = isUpload ? { type: 'binary_upload', file: req.file?.originalname } : scrubPayload(req.body);
        }

        // Auto Block logic
        if (res.statusCode === 401 && r.project.metadata?.security?.auto_block_401) {
            const isSafeIp = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.startsWith('172.') || clientIp.startsWith('10.') || clientIp.startsWith('192.168.'); 
            if (!isSafeIp && !r.project.blocklist?.includes(clientIp)) {
                systemPool.query('UPDATE system.projects SET blocklist = array_append(blocklist, $1) WHERE slug = $2', [clientIp, r.project.slug]).catch(err => console.error("Auto-block failed", err));
            }
        }

        // Firehose Buffer
        SystemLogService.bufferAuditLog({
            project_slug: r.project.slug,
            method: req.method,
            path: req.path,
            status_code: res.statusCode,
            client_ip: clientIp,
            duration_ms: duration,
            user_role: r.userRole || 'unauthorized',
            payload: safeStringify(inputPayload), // Now uses the scrubbed inputPayload
            headers: safeStringify({ referer: req.headers.referer, userAgent: req.headers['user-agent'] }),
            geo_info: JSON.stringify(geoInfo),
            response_size: responseSize // NEW TELEMETRY
        });
      }
  });

  next();
};
