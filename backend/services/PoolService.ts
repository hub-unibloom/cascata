import pg from 'pg';
const { Pool } = pg;

/**
 * PoolService
 * Responsável por gerenciar o ciclo de vida das conexões com bancos de dados de projetos (Tenants).
 * Mantém um cache de pools ativos para evitar overhead de conexão (handshake SSL/TCP) a cada requisição.
 */
export class PoolService {
  private static pools = new Map<string, pg.Pool>();

  /**
   * Obtém um pool de conexão para um banco de dados específico.
   * Se o pool já existir, retorna a instância em cache.
   * Se não, cria uma nova conexão.
   * 
   * @param dbName Nome do banco de dados do projeto (ex: cascata_proj_xyz)
   */
  public static get(dbName: string): pg.Pool {
    if (this.pools.has(dbName)) {
      return this.pools.get(dbName)!;
    }

    const baseUrl = process.env.SYSTEM_DATABASE_URL || '';
    let dbUrl = '';
    
    // Tratamento robusto para connection strings
    if (baseUrl.includes(' ')) {
       throw new Error("Invalid connection string format in env SYSTEM_DATABASE_URL");
    } else {
       // Substitui o nome do banco na URL de conexão
       dbUrl = baseUrl.replace(/\/[^\/?]+(\?.*)?$/, `/${dbName}$1`);
    }

    const pool = new Pool({
      connectionString: dbUrl,
      max: 15, // Limite de conexões simultâneas por projeto
      idleTimeoutMillis: 120000, // Fecha conexões ociosas após 2 minutos
      connectionTimeoutMillis: 5000, // Timeout para estabelecer conexão
    });

    pool.on('error', (err) => {
      console.error(`[PoolService] Erro inesperado no banco ${dbName}:`, err.message);
      // Opcional: Remover do cache se o erro for fatal
    });

    this.pools.set(dbName, pool);
    return pool;
  }

  /**
   * Encerra um pool de conexão e o remove do cache.
   * Deve ser chamado quando um projeto é excluído ou pausado.
   */
  public static async close(dbName: string) {
    if (this.pools.has(dbName)) {
      console.log(`[PoolService] Closing pool for ${dbName}`);
      await this.pools.get(dbName)?.end();
      this.pools.delete(dbName);
    }
  }

  /**
   * Encerra todos os pools ativos. Útil para Graceful Shutdown do servidor.
   */
  public static async closeAll() {
      const promises = Array.from(this.pools.keys()).map(key => this.close(key));
      await Promise.all(promises);
  }
}