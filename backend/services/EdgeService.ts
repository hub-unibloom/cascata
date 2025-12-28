
import ivm from 'isolated-vm';
import { Pool } from 'pg';

export class EdgeService {
    
    /**
     * Executa uma função server-side (Edge Function) em um ambiente V8 ISOLADO.
     * Segurança: Usa isolated-vm para prevenir acesso ao process.env, fs e rede não autorizada.
     * 
     * @param code O código JS da função
     * @param context Objeto com dados da requisição (body, query, headers, user)
     * @param envVars Variáveis de ambiente configuradas para a função
     * @param projectPool Pool de conexão do projeto (para permitir acesso ao banco)
     * @param timeoutMs Tempo limite de execução em milissegundos
     */
    public static async execute(
        code: string,
        context: any,
        envVars: Record<string, string>,
        projectPool: Pool,
        timeoutMs: number = 5000
    ): Promise<{ status: number, body: any }> {
        
        // 1. Criação da Isolate (Heap separado, 128MB limite hardcoded por segurança)
        const isolate = new ivm.Isolate({ memoryLimit: 128 });
        const scriptContext = await isolate.createContext();
        const jail = scriptContext.global;

        try {
            // 2. Injeção de Globais Seguras
            await jail.set('global', jail.derefInto());
            
            // Injeta console.log (Proxy para o stdout do host)
            await jail.set('console', new ivm.Reference({
                log: new ivm.Callback((...args: any[]) => {
                    console.log('[EDGE LOG]', ...args);
                }),
                error: new ivm.Callback((...args: any[]) => {
                    console.error('[EDGE ERR]', ...args);
                })
            }));

            // Injeta Variáveis de Ambiente
            await jail.set('env', new ivm.ExternalCopy(envVars).copyInto());

            // Injeta Contexto da Requisição
            await jail.set('req', new ivm.ExternalCopy(context).copyInto());

            // 3. Helper de Banco de Dados (Proxy Assíncrono Seguro)
            // O código na VM chamará db.query(sql, params) que será executado no Host
            await jail.set('db', new ivm.Reference({
                query: new ivm.Reference(async (sql: string, params: any[]) => {
                    // TODO: Implementar Circuit Breaker na próxima fase
                    const client = await projectPool.connect();
                    try {
                        const result = await client.query(sql, params);
                        return new ivm.ExternalCopy(result.rows).copyInto();
                    } catch (e: any) {
                        throw new Error(e.message);
                    } finally {
                        client.release();
                    }
                })
            }));

            // Injeta fetch (Simplificado)
            await jail.set('fetch', new ivm.Reference(async (url: string, init: any) => {
                const response = await fetch(url, init);
                const text = await response.text();
                // Retorna um objeto simplificado serializável
                return new ivm.ExternalCopy({
                    status: response.status,
                    statusText: response.statusText,
                    text: () => text,
                    json: () => JSON.parse(text)
                }).copyInto();
            }));

            // 4. Compilação e Execução
            // Envolvemos o código do usuário para suportar async/await top-level simulado
            const wrappedCode = `
                (async () => {
                    const dbProxy = {
                        query: async (sql, params) => {
                            return await db.get('query').apply(undefined, [sql, params], { arguments: { copy: true }, result: { promise: true } });
                        }
                    };
                    
                    const fetchProxy = async (url, init) => {
                        const res = await fetch.apply(undefined, [url, init], { arguments: { copy: true }, result: { promise: true } });
                        return {
                            status: res.status,
                            statusText: res.statusText,
                            text: async () => res.text(),
                            json: async () => res.json()
                        };
                    };

                    // Ambiente exposto ao usuário
                    const userDb = dbProxy;
                    const userFetch = fetchProxy;
                    
                    // Função do usuário inserida aqui
                    const userFunction = async () => {
                        ${code}
                    };

                    try {
                        const result = await userFunction();
                        return JSON.stringify(result); // Serializa retorno
                    } catch (e) {
                        return JSON.stringify({ error: e.message, isError: true });
                    }
                })()
            `;

            const script = await isolate.compileScript(wrappedCode);
            
            const resultStr = await script.run(scriptContext, { 
                timeout: timeoutMs,
                promise: true 
            });

            const result = JSON.parse(resultStr);

            if (result && result.isError) {
                return { status: 500, body: { error: `Script Error: ${result.error}` } };
            }

            return {
                status: 200,
                body: result
            };

        } catch (e: any) {
            console.error("Edge Execution Security Error:", e);
            
            // Tratamento Diferenciado de Erros de Infraestrutura
            if (e.message.includes('isolate is disposed')) {
                return { status: 504, body: { error: `Execution Timed Out (Limit: ${timeoutMs}ms)` } };
            }
            if (e.message.includes('memory limit')) {
                return { status: 507, body: { error: "Memory Limit Exceeded (128MB)" } };
            }
            
            return { status: 500, body: { error: `Runtime Error: ${e.message}` } };
        } finally {
            // Garante liberação de memória
            try {
                scriptContext.release();
                if (!isolate.isDisposed) isolate.dispose();
            } catch(cleanupErr) { /* ignore cleanup errors */ }
        }
    }
}
