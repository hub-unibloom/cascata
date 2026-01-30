
import { RequestHandler } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool } from '../config/main.js';
import { WebhookService } from '../../services/WebhookService.js';
import { SystemLogService } from '../../services/SystemLogService.js';

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

// Safe Stringify Implementation (Basic)
// Prevents circular structure crash and limits output size
const safeStringify = (obj: any, limit: number = 2000): string => {
    try {
        const cache = new Set();
        const str = JSON.stringify(obj, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (cache.has(value)) {
                    // Circular reference found, discard key
                    return;
                }
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
  const r = req as CascataRequest;

  if (req.path.includes('/realtime')) return next();

  (res as any).json = function(data: any) {
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

       // Request Payload Check (Security Fix: OOM Prevention)
       const isUpload = req.headers['content-type']?.includes('multipart/form-data');
       let inputPayload: any = {};
       
       const contentLength = parseInt(req.headers['content-length'] || '0');
       if (contentLength > 50000) { // If payload > 50KB, truncate strictly before parsing/stringify logic if possible, or just mark as large
           inputPayload = { type: 'large_payload_truncated', size: contentLength };
       } else {
           inputPayload = isUpload ? { type: 'binary_upload', file: req.file?.originalname } : req.body;
       }

       // Security: Auto Block 401
       if (res.statusCode === 401 && r.project.metadata?.security?.auto_block_401) {
          const isSafeIp = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.startsWith('172.') || clientIp.startsWith('10.') || clientIp.startsWith('192.168.'); 
          if (!isSafeIp && !r.project.blocklist?.includes(clientIp)) {
             systemPool.query('UPDATE system.projects SET blocklist = array_append(blocklist, $1) WHERE slug = $2', [clientIp, r.project.slug]).catch(err => console.error("Auto-block failed", err));
          }
       }

       // 1. Audit Log Insert via Firehose (Optimized)
       SystemLogService.bufferAuditLog({
           project_slug: r.project.slug,
           method: req.method,
           path: req.path,
           status_code: res.statusCode,
           client_ip: clientIp,
           duration_ms: duration,
           user_role: r.userRole || 'unauthorized',
           payload: safeStringify(inputPayload),
           headers: safeStringify({ referer: req.headers.referer, userAgent: req.headers['user-agent'] }),
           geo_info: JSON.stringify(geoInfo)
       });
       
       // 2. Webhook Dispatch (ONLY on Success 2xx)
       if (res.statusCode >= 200 && res.statusCode < 300 && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
           let tableName = '*';
           if (req.path.includes('/tables/')) { 
               const parts = req.path.split('/tables/'); 
               if (parts[1]) tableName = parts[1].split('/')[0]; 
           } else if (req.path.includes('/rest/v1/')) {
               const parts = req.path.split('/rest/v1/'); 
               if (parts[1]) tableName = parts[1].split('/')[0];
           }

           const webhookPayload = data; 

           WebhookService.dispatch(
               r.project.slug, 
               tableName, 
               semanticAction || req.method, 
               webhookPayload, 
               systemPool, 
               r.project.jwt_secret
           );
       }
    }
    return oldJson.apply(res, arguments as any);
  }
  next();
};
