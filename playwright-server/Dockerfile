FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Dépendances Node
COPY package*.json ./
RUN npm ci --only=production

# Code source
COPY playwright-server.js ./

# Répertoires de travail
RUN mkdir -p /sessions /app/logs

# Utilisateur non-root pour la sécurité
RUN groupadd -r pwuser && useradd -r -g pwuser pwuser \
    && chown -R pwuser:pwuser /app /sessions

USER pwuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "playwright-server.js"]
