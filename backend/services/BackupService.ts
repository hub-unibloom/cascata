import archiver from 'archiver';
import { Pool } from 'pg';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';

interface ProjectMetadata {
    id: string;
    name: string;
    slug: string;
    db_name: string;
    jwt_secret: string;
    anon_key: string;
    service_key: string;
    custom_domain?: string;
    storage_path?: string;
}

interface TableDefinition {
    schema: string;
    name: string;
}

export class BackupService {
    
    /**
     * Gera um arquivo .caf (ZIP Stream) contendo todo o estado do projeto.
     * Inclui schemas 'public' e 'auth'.
     */
    public static async streamExport(project: ProjectMetadata, systemPool: Pool, res: any) {
        const archive = archiver('zip', {
            zlib: { level: 9 } // Compressão máxima
        });

        // Pipeline de erro do arquivo
        archive.on('error', (err) => {
            console.error('[BackupService] Archiver error:', err);
            if (!res.headersSent) {
                res.status(500).send({ error: 'Falha durante a compressão do backup.' });
            } else {
                res.end(); // Encerra o stream corrompido
            }
        });

        // Conecta o stream do arquivo à resposta HTTP
        res.attachment(`${project.slug}_full_backup_${new Date().toISOString().split('T')[0]}.caf`);
        archive.pipe(res);

        try {
            // 1. MANIFESTO
            console.log(`[Backup] Generating Manifest for ${project.slug}...`);
            const manifest = {
                version: '1.1', // Bumped version for schema support
                exported_at: new Date().toISOString(),
                project: {
                    name: project.name,
                    slug: project.slug,
                    db_name: project.db_name,
                    jwt_secret: project.jwt_secret, 
                    anon_key: project.anon_key,
                    service_key: project.service_key,
                    custom_domain: project.custom_domain
                }
            };
            archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

            // 2. SCHEMA (DDL)
            console.log(`[Backup] Dumping Schema for ${project.slug}...`);
            const schemaStream = await this.getSchemaDumpStream(project.db_name);
            archive.append(schemaStream, { name: 'schema/structure.sql' });

            // 3. DADOS (CSV Streams)
            console.log(`[Backup] Streaming Data Tables for ${project.slug}...`);
            const tables = await this.listTables(project.db_name);
            for (const table of tables) {
                // Cria um stream CSV para cada tabela (schema.table.csv)
                const tableStream = await this.getTableDataStream(project.db_name, table.schema, table.name);
                archive.append(tableStream, { name: `data/${table.schema}.${table.name}.csv` });
            }

            // 4. STORAGE (Arquivos Físicos)
            console.log(`[Backup] Archiving Storage for ${project.slug}...`);
            const projectStoragePath = path.resolve(process.env.STORAGE_ROOT || '../storage', project.slug);
            if (fs.existsSync(projectStoragePath)) {
                archive.directory(projectStoragePath, 'storage');
            } else {
                // Cria pasta vazia no zip se não houver arquivos
                archive.append('', { name: 'storage/.keep' }); 
            }

            // Finaliza o arquivo
            await archive.finalize();
            console.log(`[Backup] Export completed for ${project.slug}.`);

        } catch (e: any) {
            console.error('[BackupService] Critical Error:', e);
            archive.abort(); 
            throw e;
        }
    }

    // --- INTERNAL HELPERS ---

    private static getDbUrl(dbName: string): string {
        const user = process.env.DB_USER || 'cascata_admin';
        const pass = process.env.DB_PASS || 'secure_pass';
        const host = process.env.DEFAULT_PROJECT_DB_HOST || 'db'; 
        return `postgresql://${user}:${pass}@${host}:5432/${dbName}`;
    }

    private static async listTables(dbName: string): Promise<TableDefinition[]> {
        const pool = new Pool({ connectionString: this.getDbUrl(dbName) });
        try {
            const res = await pool.query(`
                SELECT table_schema, table_name 
                FROM information_schema.tables 
                WHERE table_schema IN ('public', 'auth') 
                AND table_type = 'BASE TABLE'
                AND table_name NOT LIKE '_deleted_%'
            `);
            return res.rows.map(r => ({ schema: r.table_schema, name: r.table_name }));
        } finally {
            await pool.end();
        }
    }

    private static async getSchemaDumpStream(dbName: string): Promise<Readable> {
        const env = { ...process.env, PGPASSWORD: process.env.DB_PASS };
        const host = process.env.DEFAULT_PROJECT_DB_HOST || 'db';

        const child = spawn('pg_dump', [
            '-h', host,
            '-U', process.env.DB_USER || 'postgres',
            '-d', dbName,
            '--schema-only',
            '--no-owner',
            '--no-privileges'
        ], { env });

        child.stderr.on('data', (data) => {
            console.warn(`[pg_dump warning]: ${data.toString()}`);
        });

        return child.stdout;
    }

    private static async getTableDataStream(dbName: string, schema: string, tableName: string): Promise<Readable> {
        const env = { ...process.env, PGPASSWORD: process.env.DB_PASS };
        const host = process.env.DEFAULT_PROJECT_DB_HOST || 'db';
        
        // Comando COPY seguro com schema qualificado
        const query = `COPY (SELECT * FROM "${schema}"."${tableName}") TO STDOUT WITH CSV HEADER`;

        const child = spawn('psql', [
            '-h', host,
            '-U', process.env.DB_USER || 'postgres',
            '-d', dbName,
            '-c', query
        ], { env });

        child.stderr.on('data', (data) => {
            const msg = data.toString();
            if (!msg.includes('NOTICE')) console.warn(`[psql copy warning ${schema}.${tableName}]: ${msg}`);
        });

        return child.stdout;
    }
}