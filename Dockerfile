FROM node:22-alpine
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=512
WORKDIR /app
COPY worker/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts
COPY worker/src ./src
USER node
EXPOSE 8080
CMD ["npm", "start"]
