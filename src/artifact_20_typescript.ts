import * as http from "http";

const HEALTH_PORT = process.env.PORT || 8080;
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    try {
      const slot = await connection.getSlot("processed");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "UP",
        cluster: "mainnet-beta",
        currentSlot: slot,
        oracleAddress: relayerKeypair.publicKey.toBase58(),
        uptimeSeconds: process.uptime()
      }));
    } catch (e: any) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "DEGRADED", error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(HEALTH_PORT, () => {
  console.log(`[Healthcheck] Listening on port ${HEALTH_PORT}`);
});