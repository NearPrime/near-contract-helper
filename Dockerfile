FROM node:14-alpine

ENV NODE_ENV=production

WORKDIR /app
COPY package*.json .
RUN yarn install --production
RUN npm i -g sequelize-cli
COPY . .
RUN chmod +x ./scripts/docker_entrypoint.sh
EXPOSE 3000