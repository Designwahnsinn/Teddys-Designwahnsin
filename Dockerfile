FROM node:20-alpine

WORKDIR /app

# python3/make/g++ werden nur als Fallback gebraucht, falls better-sqlite3
# für diese Plattform kein vorkompiliertes Binary mitbringt
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads data

EXPOSE 3000 3001

CMD ["node", "server-public.js"]
