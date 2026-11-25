FROM node:22-alpine
WORKDIR /app
COPY server.js ./
RUN mkdir /data && chown node:node /data
ENV PORT=3030 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3030
USER node
CMD ["node", "server.js"]
