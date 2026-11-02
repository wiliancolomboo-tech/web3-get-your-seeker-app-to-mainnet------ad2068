cp .env.example .env
# Set production RPC, merchant keypair and Resend credentials.
docker compose up -d --build
curl https://api.pay.pixana.app/readyz