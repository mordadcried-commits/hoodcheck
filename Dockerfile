FROM node:22-alpine
WORKDIR /app

# Once sadece package.json: bagimliliklar degismedikce bu katman onbellekte kalir
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY tsconfig.json ./

# Onbellek ve log klasorlerini root olmayan kullanici yazabilsin
RUN mkdir -p /app/data /app/logs && chown -R node:node /app
USER node

ENV HOODCHECK_HOST=0.0.0.0
ENV HOODCHECK_PORT=8080
EXPOSE 8080
CMD ["npm","start"]
