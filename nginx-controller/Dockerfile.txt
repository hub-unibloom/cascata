FROM node:20-alpine

WORKDIR /app

# Instala Docker CLI para poder executar comandos no socket
RUN apk add --no-cache docker-cli

COPY package.json .
RUN npm install

COPY index.js .

EXPOSE 3001
CMD ["node", "index.js"]