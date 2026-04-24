FROM node:20-bookworm-slim
WORKDIR /app

ARG INSTALL_LMS=true

RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl ca-certificates bash libatomic1 \
	&& rm -rf /var/lib/apt/lists/*

RUN if [ "$INSTALL_LMS" = "true" ]; then curl -fsSL https://lmstudio.ai/install.sh | bash; fi

COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 8090
CMD ["node", "src/index.js"]
