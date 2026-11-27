# Onda — Azure deploy

Single container: Fastify API serves the Vite web build same-origin when `SERVE_WEB=true`.
SQLite at `DATABASE_PATH` (mounted Azure Files share on Container Apps). Env: EXECUTION_ENABLED=false, EXECUTION_MODE=paper, AGENT_MODE=parser, SESSION_SECRET as Container Apps secret only.

Build: `docker build -f deploy/Dockerfile -t onda .`
Run local: `docker run -p 8080:8080 -e SESSION_SECRET=$(openssl rand -hex 32) onda`
