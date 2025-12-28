import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { CertificateService } from './CertificateService.js';

export class MigrationService {
  /**
   * Executa as migrações pendentes na pasta /migrations.
   * Cria a tabela system.migrations se não existir.
   * 
   * @param systemPool Pool de conexão do sistema
   * @param migrationsRoot Caminho absoluto para a pasta de migrações
   */
  public static async run(systemPool: Pool, migrationsRoot: string) {
    console.log('[MigrationService] Check started...');
    let client;
    try {
      client = await systemPool.connect();
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
        .sort(); // Garante ordem alfabética (001, 002, etc.)

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
          } catch (err: any) {
            await client.query('ROLLBACK');
            // Loga o erro mas não derruba o boot, para permitir correções via API se possível
            console.warn(`[MigrationService] Failed ${file}: ${err.message}. Skipping to preserve boot.`);
          }
        }
      }
      
      // Após migrações, recarrega configs do Nginx pois podem haver novos projetos
      await CertificateService.rebuildNginxConfigs(systemPool);
      
    } catch (e: any) {
      console.error('[MigrationService] Critical Error:', e.message);
    } finally {
      if (client) client.release();
    }
  }
}