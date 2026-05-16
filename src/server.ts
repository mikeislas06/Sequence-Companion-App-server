import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
	cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
	console.log("connected:", socket.id);
	socket.on("disconnect", () => console.log("disconnected:", socket.id));
});

const PORT = process.env.PORT ?? 3001;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));

export { io };
