
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { CertificateService } from './CertificateService.js';

export class MigrationService {
  // Use a fixed key for the advisory lock to ensure all instances contend for the same lock
  private static readonly LOCK_ID = 8675309; 

  public static async run(systemPool: Pool, migrationsRoot: string) {
    console.log('[MigrationService] Initializing...');
    let client;
    
    try {
      client = await systemPool.connect();
      
      // 1. Acquire Distributed Lock
      // pg_advisory_lock blocks until lock is available. 
      // This ensures only one node runs migrations at a time, and others wait.
      console.log('[MigrationService] Waiting for distributed lock...');
      await client.query(`SELECT pg_advisory_lock(${this.LOCK_ID})`);
      console.log('[MigrationService] Lock acquired. Starting checks...');

      try {
          // --- CRITICAL SECTION START ---
          
          await client.query(`CREATE SCHEMA IF NOT EXISTS system`);
          await client.query(`
            CREATE TABLE IF NOT EXISTS system.migrations (
              id SERIAL PRIMARY KEY,
              name TEXT UNIQUE NOT NULL,
              applied_at TIMESTAMP DEFAULT NOW()
            )
          `);

          if (!fs.existsSync(migrationsRoot)) {
            console.warn('[MigrationService] Migrations folder not found.');
            return;
          }

          const files = fs.readdirSync(migrationsRoot)
            .filter(f => f.endsWith('.sql') || f.endsWith('.sql.txt'))
            .sort();

          for (const file of files) {
            const check = await client.query('SELECT id FROM system.migrations WHERE name = $1', [file]);
            if (check.rowCount === 0) {
              console.log(`[MigrationService] Applying: ${file}`);
              const sql = fs.readFileSync(path.join(migrationsRoot, file), 'utf-8');
              try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO system.migrations (name) VALUES ($1)', [file]);
                await client.query('COMMIT');
                console.log(`[MigrationService] Success: ${file}`);
              } catch (err: any) {
                await client.query('ROLLBACK');
                console.warn(`[MigrationService] Failed ${file}: ${err.message}. Skipping to preserve boot.`);
              }
            }
          }
          
          await CertificateService.rebuildNginxConfigs(systemPool);
          
          // --- CRITICAL SECTION END ---
          
      } finally {
          // Always release the lock
          await client.query(`SELECT pg_advisory_unlock(${this.LOCK_ID})`);
          console.log('[MigrationService] Lock released.');
      }
      
    } catch (e: any) {
      console.error('[MigrationService] Critical Error:', e.message);
    } finally {
      if (client) client.release();
    }
  }
}
