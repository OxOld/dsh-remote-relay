FROM node:22-alpine
WORKDIR /app
COPY relay.mjs ./
COPY public ./public
ENV RELAY_PORT=8787
EXPOSE 8787
CMD ["node", "relay.mjs"]
