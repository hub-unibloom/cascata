
import pg from 'pg';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import process from 'process';

dotenv.config();

const { Pool } = pg;

const APP_ROOT = path.resolve('.');

export const STORAGE_ROOT = process.env.STORAGE_ROOT || path.resolve(APP_ROOT, '../storage');
export const MIGRATIONS_ROOT = process.env.MIGRATIONS_ROOT || path.resolve(APP_ROOT, 'migrations');
export const TEMP_UPLOAD_ROOT = process.env.TEMP_UPLOAD_ROOT || path.resolve(APP_ROOT, 'temp_uploads');
export const NGINX_DYNAMIC_ROOT = process.env.NGINX_DYNAMIC_ROOT || '/etc/nginx/conf.d/dynamic';

const ensureDir = (dir: string) => {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    } catch (e) {
        console.error(`[Config] Error creating directory ${dir}:`, e);
    }
};

ensureDir(STORAGE_ROOT);
ensureDir(NGINX_DYNAMIC_ROOT);
ensureDir(TEMP_UPLOAD_ROOT);

if (!process.env.SYSTEM_DATABASE_URL) {
    console.error('[Config] FATAL: SYSTEM_DATABASE_URL is not defined.');
    process.exit(1);
}

export const systemPool = new Pool({ 
  connectionString: process.env.SYSTEM_DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000 
});

systemPool.on('error', (err) => {
    console.error('[SystemPool] Unexpected error on idle client', err);
});

export const upload = multer({ 
    dest: TEMP_UPLOAD_ROOT,
    limits: {
        fileSize: 100 * 1024 * 1024, 
        fieldSize: 10 * 1024 * 1024 
    }
});

export const backupUpload = multer({ 
    dest: TEMP_UPLOAD_ROOT,
    limits: { fileSize: 5 * 1024 * 1024 * 1024 } 
});

if (!process.env.SYSTEM_JWT_SECRET) {
    console.error('[Config] FATAL: SYSTEM_JWT_SECRET is missing. Security cannot be guaranteed.');
    process.exit(1);
}

export const SYS_SECRET = process.env.SYSTEM_JWT_SECRET;

export const MAGIC_NUMBERS: Record<string, string[]> = {
    'jpg': ['FFD8FF'],
    'png': ['89504E47'],
    'gif': ['47494638'],
    'pdf': ['25504446'],
    'exe': ['4D5A'], 
    'zip': ['504B0304'],
    'rar': ['52617221'],
    'mp3': ['494433', 'FFF3', 'FFF2'],
    'mp4': ['000000', '66747970'],
};
