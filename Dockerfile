FROM node:24-slim

# Add fonts-dejavu-core and fontconfig so FFmpeg has fonts for drawtext
RUN apt-get update && apt-get install -y ffmpeg fonts-dejavu-core fontconfig && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
COPY . .

EXPOSE 8080
ENV PORT=8080

CMD ["node", "node_modules/.bin/functions-framework", "--target=helloHttp"]
