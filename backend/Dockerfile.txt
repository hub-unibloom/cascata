
FROM node:20-alpine
WORKDIR /app

# Contexto agora é ./backend
COPY package*.json ./

# Adiciona docker-cli para permitir reload do nginx e openssl/certbot para SSL
# Adiciona postgresql-client para pg_dump e psql (Import/Export)
# Adiciona python3, make e g++ para compilação do isolated-vm (Native Module)
# CRITICAL: Adicionado tzdata para suporte a Timezones no Node.js
# CRITICAL: Adicionado zip/unzip para Backup/Restore
RUN apk add --no-cache certbot openssl docker-cli postgresql-client python3 make g++ tzdata zip unzip
RUN npm install

# Copia arquivos do backend
COPY . .

RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
