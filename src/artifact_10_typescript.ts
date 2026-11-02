// Fastify / Express endpoints embedded in gateway server
app.get("/healthz", async (req, reply) => {
  const isRpcConnected = await connection.getVersion().then(() => true).catch(() => false);
  if (!isRpcConnected) {
    return reply.status(503).send({ status: "UNHEALTHY", reason: "RPC connection dropped" });
  }
  return reply.status(200).send({
    status: "HEALTHY",
    uptime: process.uptime(),
    timestamp: Date.now(),
    network: "Solana Mainnet-Beta"
  });
});

app.get("/metrics", async (req, reply) => {
  return reply.status(200).send({
    processedOrdersCount: gateway.getProcessedCount(),
    memoryUsage: process.memoryUsage(),
  });
});