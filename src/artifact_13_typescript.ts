import express from "express";
import { Connection } from "@solana/web3.js";

const app = express();
const port = process.env.PORT || 8080;
const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed"
);

app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    const slot = await connection.getSlot();
    res.status(200).json({
      status: "UP",
      solanaSlot: slot,
      network: "mainnet-beta",
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(503).json({ status: "DEGRADED", error: err.message });
  }
});

app.listen(port, () => {
  console.log(`[SeekerPix Enterprise Engine] Listening on port ${port}`);
});