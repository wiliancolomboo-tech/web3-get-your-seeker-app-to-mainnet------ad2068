// Insert into src/index.ts for HTTP container health probes:
import * as http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "HEALTHY", timestamp: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(8080, () => console.log("Healthcheck endpoint online at :8080/healthz"));