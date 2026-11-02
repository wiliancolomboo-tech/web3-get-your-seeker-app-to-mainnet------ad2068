import * as http from 'http';
import { Connection } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    try {
      const slot = await connection.getSlot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'UP',
        currentSlot: slot,
        network: 'Solana Mainnet-Beta',
        timestamp: new Date().toISOString()
      }));
    } catch (e: any) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'DOWN', error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, () => {
  console.log('[Telemetry] Healthcheck server listening on port 8080');
});