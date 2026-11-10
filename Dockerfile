# The maze solver GUI. Used by docker-compose.yml together with an Ollama container.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 4173
CMD ["npm", "run", "gui"]
