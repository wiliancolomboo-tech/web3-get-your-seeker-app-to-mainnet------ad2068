import http from "http";

const HEALTH_PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "UP",
      subsystem: "seeker-pix-brazil-gateway",
      network: "mainnet-beta",
      uptime: process.uptime(),
      timestamp: Date.now()
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(HEALTH_PORT, () => {
  console.log(`[HEALTH] Healthcheck listening on port ${HEALTH_PORT}`);
});