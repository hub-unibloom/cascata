import { GoogleGenAI } from "@google/genai";
import { Pool } from 'pg';

export class AiService {
    
    private static getClient(apiKey: string) {
        if (!apiKey) throw new Error("AI API Key not configured in System Settings.");
        return new GoogleGenAI({ apiKey });
    }

    private static async getContext(pool: Pool) {
        // Obter esquema do banco para dar contexto à IA
        const tablesRes = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        `);
        const tables = tablesRes.rows.map(r => r.table_name);
        
        let schemaSummary = "Database Schema:\n";
        for (const t of tables) {
            const cols = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`, [t]);
            schemaSummary += `- Table ${t}: ${cols.rows.map(c => `${c.column_name}(${c.data_type})`).join(', ')}\n`;
        }
        return schemaSummary;
    }

    public static async chat(projectSlug: string, pool: Pool, systemSettings: any, body: any) {
        const { messages, session_id } = body;
        const apiKey = systemSettings.ai_config?.api_key;
        const modelName = systemSettings.ai_config?.model || 'gemini-2.5-flash';

        const ai = this.getClient(apiKey);
        const context = await this.getContext(pool);

        const systemInstruction = `
            You are Cascata Architect, an expert backend engineer helper.
            You are managing a project named "${projectSlug}".
            
            ${context}

            If the user asks to create a table, return a JSON object with this structure inside your response (wrapped in \`\`\`json):
            {
                "action": "create_table",
                "name": "table_name",
                "description": "description",
                "columns": [
                    {"name": "col_name", "type": "text|integer|boolean|uuid|timestamptz|jsonb", "isPrimaryKey": boolean, "description": "desc"}
                ]
            }

            If the user asks for SQL, write it in a \`\`\`sql block.
            Be concise and technical.
        `;

        // Converter histórico para formato do Gemini (se necessário) ou enviar apenas o último prompt com contexto
        // Para simplificar, estamos enviando uma chamada generateContent com o histórico concatenado ou estruturado se usar ChatSession
        // Aqui usamos generateContent simples com instrução
        
        const lastMsg = messages[messages.length - 1].content;
        
        const response = await ai.models.generateContent({
            model: modelName,
            contents: [
                { role: 'user', parts: [{ text: `History: ${JSON.stringify(messages.slice(0, -1))}\n\nUser: ${lastMsg}` }] }
            ],
            config: {
                systemInstruction,
                temperature: 0.2
            }
        });

        // Salvar histórico no banco (system.ai_history) - Opcional, mas recomendado
        // Aqui apenas retornamos a resposta
        
        return {
            choices: [{
                message: {
                    role: 'assistant',
                    content: response.text
                }
            }]
        };
    }

    public static async draftDoc(projectSlug: string, pool: Pool, systemSettings: any, tableName: string) {
        const apiKey = systemSettings.ai_config?.api_key;
        const modelName = systemSettings.ai_config?.model || 'gemini-2.5-flash';
        const ai = this.getClient(apiKey);

        // Obter detalhes da tabela
        const cols = await pool.query(`
            SELECT column_name, data_type, is_nullable 
            FROM information_schema.columns 
            WHERE table_name = $1 AND table_schema = 'public'
        `, [tableName]);

        const schemaStr = cols.rows.map(c => `- ${c.column_name} (${c.data_type}) ${c.is_nullable === 'YES' ? 'Optional' : 'Required'}`).join('\n');

        const prompt = `
            Write a technical documentation guide for a developer integrating with the "${tableName}" table in the "${projectSlug}" API.
            
            Table Schema:
            ${schemaStr}

            Include:
            1. Overview of the entity.
            2. Authentication method (headers).
            3. cURL examples for GET (List) and POST (Create).
            4. TypeScript interface definition.
            
            Format as Markdown.
        `;

        const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt
        });

        return {
            id: `doc-${tableName}-${Date.now()}`,
            title: `Integration Guide: ${tableName}`,
            content_markdown: response.text
        };
    }
}