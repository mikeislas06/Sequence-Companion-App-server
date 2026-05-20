import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import { registerHandlers } from "./event-handlers";

const ALLOWED_ORIGIN = process.env.CLIENT_URL ?? "http://localhost:3000";

const app = express();
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
	cors: { origin: ALLOWED_ORIGIN, methods: ["GET", "POST"] },
});

registerHandlers(io);

const PORT = process.env.PORT ?? 3001;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
