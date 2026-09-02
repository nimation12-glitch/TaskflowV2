# TaskFlow backend — self-hosted (standalone Next.js output)
# Build:  docker build -t taskflow-backend .
# Run:    docker run -p 4000:4000 --env-file .env taskflow-backend
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
ENV HOSTNAME=0.0.0.0

COPY .next/standalone ./
COPY .next/static ./.next/static
COPY public ./public

EXPOSE 4000
CMD ["node", "server.js"]
