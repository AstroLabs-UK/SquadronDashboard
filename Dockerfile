FROM node:22-slim

WORKDIR /app

# Dependencies first, so rebuilds are quick when only the code changed.
# Uses the lockfile (exact versions) when the repo has one.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY *.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public

# The app runs as the unprivileged "node" user. The entrypoint starts as root only long enough to
# make the bind-mounted data folder writable by that user, then drops privileges.
COPY docker-entrypoint.sh /usr/local/bin/sqndash-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/sqndash-entrypoint.sh && chmod +x /usr/local/bin/sqndash-entrypoint.sh \
 && mkdir -p /app/data && chown -R node:node /app/data

EXPOSE 3000

# Docker marks the container "unhealthy" if the dashboard stops answering
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["sh", "/usr/local/bin/sqndash-entrypoint.sh"]
CMD ["node", "server.js"]
