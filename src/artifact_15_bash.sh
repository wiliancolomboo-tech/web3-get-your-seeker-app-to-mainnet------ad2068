# 1. Export required enterprise environment variables
export RESEND_API_KEY="re_live_production_secret_key"
export MERCHANT_WEBHOOK_URL="https://merchant-api.empresa.com.br/v1/seeker-notify"
export WEBHOOK_HMAC_SECRET="7f9e8d4a6b2c1e0f"

# 2. Launch production container stack
docker compose up -d --build

# 3. Verify healthcheck endpoint
curl -i http://localhost:8080/healthz
# HTTP/1.1 200 OK
# {"status":"HEALTHY","uptime":14.2,"processedCount":0,"rpcEndpoint":"https://api.mainnet-beta.solana.com"}

# 4. Execute an end-to-end integration receipt test dispatch
curl -X POST http://localhost:8080/api/v1/pos/mock-settlement \
  -H "Content-Type: application/json" \
  -d '{
    "customerEmail": "suporte@solana.com",
    "orderIdHex": "A1B2C3D4E5F60718",
    "amountFormatted": "125.50",
    "tokenSymbol": "USDC",
    "merchantPubkey": "SeekerPay1111111111111111111111111111111111",
    "payerPubkey": "CustomeR111111111111111111111111111111111111",
    "txSignature": "4nZ8s9q2pXy4w..."
  }'
# {"success":true,"emailId":"497f6eca-6276-4993-bfeb-53cbbbba6f08"}