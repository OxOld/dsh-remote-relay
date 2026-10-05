# dsh-remote-relay · 零依赖中继（relay.mjs + full.mjs），镜像极小（~60MB）
FROM node:22-alpine
WORKDIR /app
COPY relay.mjs full.mjs ./
COPY public ./public
# data/ 为设备注册表持久化目录，挂卷时由宿主持有
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV RELAY_PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${RELAY_PORT}/healthz" || exit 1
CMD ["node", "relay.mjs"]
