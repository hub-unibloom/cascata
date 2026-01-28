
import express, { NextFunction } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import process from 'process';

// --- CONFIG & UTILS ---
import { systemPool } from './src/config/main.js';
import { waitForDatabase, cleanTempUploads } from './src/utils/index.js';

// --- SERVICES ---
import { CertificateService } from './services/CertificateService.js';
import { MigrationService } from './services/MigrationService.js';
import { QueueService } from './services/QueueService.js';
import { RateLimitService } from './services/RateLimitService.js';
import { PoolService } from './services/PoolService.js';
import { SystemLogService } from './services/SystemLogService.js'; // NEW

// --- ROUTES ---
import mainRouter from './src/routes/index.js';

// --- MIDDLEWARES ---
import { dynamicCors, hostGuard } from './src/middlewares/security.js';
import { resolveProject } from './src/middlewares/core.js';

dotenv.config();

// --- PATHS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_ROOT = path.resolve(__dirname, '../migrations');

// --- INITIALIZE SYSTEM LOGGING (OBSERVABILITY) ---
SystemLogService.init();

// --- WORKER MODE (SCALE-OUT) ---
if (process.env.SERVICE_MODE === 'WORKER') {
    console.log('[System] Starting in DEDICATED WORKER MODE...');
    (async () => {
        try {
            await waitForDatabase(30, 2000);
            RateLimitService.init(); 
            QueueService.init();     
            console.log('[System] Worker Ready. Processing background jobs.');
            
            process.on('SIGTERM', async () => {
                console.log('[Worker] Shutting down...');
                await systemPool.end();
                process.exit(0);
            });
        } catch (e) {
            console.error('[Worker] Fatal Error:', e);
            process.exit(1);
        }
    })();
} 
else {
    // --- API SERVER MODE (DEFAULT) ---
    const app = express();
    const PORT = process.env.PORT || 3000;

    // --- INITIALIZATION ---
    RateLimitService.init();
    PoolService.initReaper(); 

    if (process.env.SERVICE_MODE === 'CONTROL_PLANE') {
        console.log('[System] Control Plane: Initializing internal queues.');
        QueueService.init(); 
    }

    // --- GARBAGE COLLECTION (TEMP FILES) ---
    // Cleans /temp_uploads every hour to prevent disk exhaustion attacks/leaks
    setInterval(() => {
        console.log('[System] Running Temp File Garbage Collection...');
        cleanTempUploads().catch(e => console.error('[GC] Failed:', e));
    }, 60 * 60 * 1000); 

    // --- SECURITY HEADERS (Global Hardening) ---
    app.use((req, res, next) => {
      // Prevent MIME-sniffing
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Clickjacking protection
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      // XSS Protection (Legacy browsers)
      res.setHeader('X-XSS-Protection', '1; mode=block');
      // HSTS (Strict HTTPS) - 1 Year
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
      // Referrer Policy to prevent leakage
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      // Cross-Domain Policies
      res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
      // Remove fingerprint
      (res as any).removeHeader('X-Powered-By'); 
      next();
    });

    // --- CORS & HOST GUARD ---
    app.use(resolveProject as any);
    app.use(dynamicCors as any);
    app.use(hostGuard as any);

    // --- HEALTH CHECK (Deep Check) ---
    app.get('/', (req, res) => { res.send('Cascata Engine v9.9 (Enterprise Hardened) OK'); });
    app.get('/health', async (req, res) => { 
        let dbStatus = 'unknown';
        try {
            await systemPool.query('SELECT 1');
            dbStatus = 'connected';
        } catch(e) { dbStatus = 'error'; }

        res.json({ 
            status: 'ok', 
            mode: process.env.SERVICE_MODE, 
            system_db: dbStatus,
            pools: PoolService.getTotalActivePools(), 
            time: new Date() 
        }); 
    });

    // --- MOUNT ROUTES ---
    app.use('/api', mainRouter);

    // --- GLOBAL ERROR HANDLER ---
    app.use((err: any, req: any, res: any, next: NextFunction) => {
      if (!err.code?.startsWith('2') && !err.code?.startsWith('4')) {
          console.error(`[Global Error] ${req.method} ${req.path}:`, err);
      }

      if (err instanceof multer.MulterError) {
          return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message, code: err.code });
      }
      
      if (err.message === "User already registered" || err.code === 'user_already_exists') {
           return res.status(422).json({ error: "user_already_exists", error_description: "User already registered" });
      }
      if (err.message === "Invalid login credentials") {
           return res.status(400).json({ error: "invalid_grant", error_description: "Invalid login credentials" });
      }

      if (err.code) {
          const pgMap: Record<string, {s: number, m: string}> = {
              '23505': { s: 409, m: 'Conflict: Record exists.' },
              '23503': { s: 400, m: 'Foreign Key Violation.' },
              '42P01': { s: 404, m: 'Table Not Found.' },
              '42703': { s: 400, m: 'Invalid Column.' },
              '23502': { s: 400, m: 'Missing Required Field.' },
              '22P02': { s: 400, m: 'Invalid Type.' },
          };
          if (pgMap[err.code]) {
              return res.status(pgMap[err.code].s).json({ error: pgMap[err.code].m, code: err.code });
          }
      }

      if (err instanceof SyntaxError && 'body' in err) {
          return res.status(400).json({ error: 'Invalid JSON Payload' });
      }

      res.status(err.status || 500).json({ 
          error: err.message || 'Internal Server Error', 
          code: err.code || 'INTERNAL_ERROR' 
      });
    });

    // --- SERVER INSTANCE ---
    const server = app.listen(PORT, () => {
        console.log(`[CASCATA SECURE ENGINE] Listening on port ${PORT} [PID: ${process.pid}]`);
    });

    // --- BOOTSTRAP LOGIC ---
    (async () => {
      try {
        console.log('[System] Booting up...');
        cleanTempUploads();
        CertificateService.ensureSystemCert().catch(e => console.error("Cert Init Error:", e));
        
        waitForDatabase(30, 2000).then(async (ready) => {
            if (ready) {
                await MigrationService.run(systemPool, MIGRATIONS_ROOT);
                
                try {
                    const dbRes = await systemPool.query("SELECT settings FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'system_config'");
                    if (dbRes.rows[0]?.settings) {
                        PoolService.configure(dbRes.rows[0].settings);
                        console.log(`[System] Loaded Global Config.`);
                    }
                } catch(e) { console.warn("[System] Failed to load global config, using defaults."); }

                console.log('[System] Platform Ready & Healthy.');
            } else {
                console.error('[System] CRITICAL: Main Database Unreachable.');
            }
        });
      } catch (e) { 
          console.error('[System] FATAL BOOT ERROR:', e); 
          process.exit(1);
      }
    })();

    // --- GRACEFUL SHUTDOWN ---
    const gracefulShutdown = async (signal: string) => {
        console.log(`[System] Received ${signal}. Shutting down gracefully...`);
        server.close(async () => {
            console.log('[System] HTTP server closed.');
            try {
                await PoolService.closeAll(); 
                await systemPool.end();
                process.exit(0);
            } catch (e) {
                console.error('[System] Error during shutdown:', e);
                process.exit(1);
            }
        });
        setTimeout(() => {
            console.error('[System] Forced shutdown due to timeout.');
            process.exit(1);
        }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => console.error('[System] Unhandled Rejection:', reason));
    process.on('uncaughtException', (error) => console.error('[System] Uncaught Exception:', error));
}
