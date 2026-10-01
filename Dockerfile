FROM node:20-slim
WORKDIR /app
COPY package.json bot-server.mjs ./
ENV PORT=3000 OFFSET_FILE=/data/offset.txt DATA_FILE=/data/bot-data.json
EXPOSE 3000
CMD ["node", "bot-server.mjs"]
