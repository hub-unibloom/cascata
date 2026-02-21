
# Build Stage
FROM node:20-alpine as build
WORKDIR /app
# Contexto agora é ./frontend, então copiamos direto
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Production Stage
FROM nginx:alpine
# Copia o build
COPY --from=build /app/dist /usr/share/nginx/html
# Copia a config do nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
