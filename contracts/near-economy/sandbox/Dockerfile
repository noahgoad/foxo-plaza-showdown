FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
WORKDIR /sandbox
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY economy.test.mjs ./
COPY sales.test.mjs ranking.test.mjs ./
CMD ["node", "--test", "--test-concurrency=1", "economy.test.mjs", "sales.test.mjs", "ranking.test.mjs"]
