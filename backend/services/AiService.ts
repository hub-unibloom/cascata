import { GoogleGenAI } from "@google/genai";
import { Pool } from 'pg';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class AiService {
    
    private static async getContext(pool: Pool) {
        try {
            const tablesRes = await pool.query(`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                AND table_name NOT LIKE '_deleted_%'
            `);
            const tables = tablesRes.rows.map(r => r.table_name);
            
            let schemaSummary = "Database Schema Context:\n";
            for (const t of tables) {
                const cols = await pool.query(`
                    SELECT column_name, data_type, is_nullable 
                    FROM information_schema.columns 
                    WHERE table_name = $1 AND table_schema = 'public'
                `, [t]);
                schemaSummary += `- Table "${t}": ${cols.rows.map(c => `${c.column_name}(${c.data_type})`).join(', ')}\n`;
            }
            return schemaSummary;
        } catch (e) {
            console.error("[AiService] Context Extraction Error:", e);
            return "No schema context available due to internal database error.";
        }
    }

    private static async generateWithRetry(parameters: { model: string, contents: any, config?: any }, retries = 3, delay = 1000): Promise<string> {
        // Inicialização direta por chamada conforme Gold Rules do Gemini
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
        try {
            const response = await ai.models.generateContent({
                model: parameters.model,
                contents: parameters.contents,
                config: parameters.config
            });
            return response.text || '';
        } catch (error: any) {
            const status = error.status || error.response?.status;
            if ((status === 503 || status === 429 || error.message?.includes('overloaded')) && retries > 0) {
                console.warn(`[AiService] Gemini Overloaded (${status}). Retrying in ${delay}ms... (${retries} left)`);
                await sleep(delay);
                return this.generateWithRetry(parameters, retries - 1, delay * 2);
            }
            throw error;
        }
    }

    public static async chat(projectSlug: string, pool: Pool, systemSettings: any, body: any) {
        const { messages, config } = body;
        const modelName = 'gemini-3-flash-preview';
        
        let context = '';
        if (!config?.skip_db_context) {
            context = await this.getContext(pool);
        }

        const systemInstruction = `
            You are Cascata Architect, a world-class senior solo leveling backend engineer.
            You are helping the user manage the BaaS project "${projectSlug}".
            
            Current Database State:
            ${context}
            
            Rules:
            1. For table creation, return a JSON block:
            \`\`\`json
            {
                "action": "create_table",
                "name": "table_name",
                "description": "purpose",
                "columns": [{"name": "col", "type": "text|uuid|...", "isPrimaryKey": true}]
            }
            \`\`\`
            2. Be technical and precise.
        `;

        const lastMsg = messages[messages.length - 1].content;
        
        const text = await this.generateWithRetry({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: `History: ${JSON.stringify(messages.slice(0, -1))}\n\nRequest: ${lastMsg}` }] }],
            config: { systemInstruction, temperature: 0.2 }
        });

        return { choices: [{ message: { role: 'assistant', content: text } }] };
    }

    public static async fixSQL(projectSlug: string, pool: Pool, systemSettings: any, sql: string, error: string) {
        const modelName = 'gemini-3-pro-preview';
        const context = await this.getContext(pool);
        const prompt = `Database Schema:\n${context}\n\nFix this SQL: ${sql}\nError: ${error}\nReturn corrected SQL in \`\`\`sql block.`;
        const text = await this.generateWithRetry({ model: modelName, contents: [{ role: 'user', parts: [{ text: prompt }] }] });
        const match = text.match(/```sql\n([\s\S]*?)\n```/);
        return match ? match[1].trim() : text.trim();
    }

    public static async draftDoc(projectSlug: string, pool: Pool, systemSettings: any, tableName: string) {
        const modelName = 'gemini-3-flash-preview';
        const prompt = `Generate API guide for table "${tableName}" in project "${projectSlug}". Use Markdown.`;
        const text = await this.generateWithRetry({ model: modelName, contents: [{ role: 'user', parts: [{ text: prompt }] }] });
        return { id: `doc-${Date.now()}`, title: `Guide: ${tableName}`, content_markdown: text };
    }

    public static async explainCode(projectSlug: string, pool: Pool, systemSettings: any, code: string, type: 'sql' | 'js') {
        const modelName = 'gemini-3-pro-preview';
        const prompt = `Explain this ${type} code: ${code}`;
        const text = await this.generateWithRetry({ model: modelName, contents: [{ role: 'user', parts: [{ text: prompt }] }] });
        return { explanation: text };
    }
}