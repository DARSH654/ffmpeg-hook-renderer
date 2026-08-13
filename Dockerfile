FROM node:24-slim

# Install FFmpeg and fontconfig
RUN apt-get update && apt-get install -y ffmpeg fontconfig && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
COPY . .

EXPOSE 8080
ENV PORT=8080

CMD ["node", "node_modules/.bin/functions-framework", "--target=helloHttp"]
