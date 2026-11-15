FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY server.mjs ./
COPY src ./src
COPY public ./public
COPY data ./data
EXPOSE 8080
CMD ["node", "server.mjs"]
