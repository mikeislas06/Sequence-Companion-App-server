import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { registerHandlers } from "./event-handlers";

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
	cors: { origin: process.env.CLIENT_URL ?? "*", methods: ["GET", "POST"] },
});

registerHandlers(io);

const PORT = process.env.PORT ?? 3001;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
