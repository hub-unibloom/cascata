import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Carrega variáveis de ambiente do nível atual ou da raiz, se necessário
  const env = loadEnv(mode, path.resolve('.'), '');

  return {
    plugins: [react()],
    root: '.', // Define a raiz como o diretório atual (frontend/)
    server: {
      port: 3001, // Frontend roda na 3001 para não conflitar com Backend (3000)
      host: true, // Expõe para a rede (necessário para Docker)
      strictPort: true,
      proxy: {
        // Redireciona chamadas /api para o Backend
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        }
      }
    },
    resolve: {
      alias: {
        // Como a estrutura é plana (sem pasta /src), o alias @ aponta para a raiz do frontend
        '@': path.resolve(__dirname, '.'),
      }
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false
    },
    define: {
      // Garante que variáveis de ambiente críticas estejam disponíveis globalmente se usadas
      'process.env.API_KEY': JSON.stringify(env.API_KEY || ''),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || '')
    }
  };
});