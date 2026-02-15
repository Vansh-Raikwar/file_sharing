const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // 100 MB for large file transfers
});

// Serve static files
app.use(express.static('public'));

// Store connected peers
const peers = new Map();

// Middleware to log connections
io.use((socket, next) => {
    // console.log(`New connection attempt: ${socket.id}`);
    next();
});

io.on('connection', (socket) => {
    // console.log(`User connected: ${socket.id}`);

    // Register peer
    socket.on('register', (peerInfo) => {
        const peer = {
            id: socket.id,
            name: peerInfo.name || 'Unknown Device',
            device: peerInfo.device || 'Browser',
            icon: peerInfo.icon || '💻'
        };
        
        peers.set(socket.id, peer);
        // console.log(`Peer registered: ${peer.name} (${socket.id})`);

        // Send current peer list to the new connection
        const peerList = Array.from(peers.values()).filter(p => p.id !== socket.id);
        socket.emit('peers-list', peerList);

        // Notify all other peers about the new peer
        socket.broadcast.emit('peer-joined', peer);
    });

    // WebRTC Signaling - Offer
    socket.on('webrtc-offer', (data) => {
        // console.log(`Relaying offer from ${socket.id} to ${data.targetId}`);
        io.to(data.targetId).emit('webrtc-offer', {
            offer: data.offer,
            senderId: socket.id,
            senderInfo: peers.get(socket.id)
        });
    });

    // WebRTC Signaling - Answer
    socket.on('webrtc-answer', (data) => {
        // console.log(`Relaying answer from ${socket.id} to ${data.targetId}`);
        io.to(data.targetId).emit('webrtc-answer', {
            answer: data.answer,
            senderId: socket.id
        });
    });

    // WebRTC Signaling - ICE Candidate
    socket.on('ice-candidate', (data) => {
        // console.log(`Relaying ICE candidate from ${socket.id} to ${data.targetId}`);
        io.to(data.targetId).emit('ice-candidate', {
            candidate: data.candidate,
            senderId: socket.id
        });
    });

    // Handle file transfer metadata (for notification purposes)
    socket.on('file-metadata', (data) => {
        // console.log(`File metadata from ${socket.id}:`, data.fileName);
        io.to(data.targetId).emit('file-incoming', {
            senderId: socket.id,
            senderInfo: peers.get(socket.id),
            fileName: data.fileName,
            fileSize: data.fileSize,
            fileType: data.fileType,
            transferId: data.transferId
        });
    });

    // Handle file acceptance
    socket.on('file-accept', (data) => {
        // console.log(`File accepted by ${socket.id}`);
        io.to(data.senderId).emit('file-accepted', {
            receiverId: socket.id,
            transferId: data.transferId
        });
    });

    // Handle file rejection
    socket.on('file-reject', (data) => {
        // console.log(`File rejected by ${socket.id}`);
        io.to(data.senderId).emit('file-rejected', {
            receiverId: socket.id,
            transferId: data.transferId,
            reason: data.reason || 'File rejected by recipient'
        });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        // console.log(`User disconnected: ${socket.id}`);
        const peer = peers.get(socket.id);
        peers.delete(socket.id);
        
        // Notify all other peers
        socket.broadcast.emit('peer-left', {
            id: socket.id,
            name: peer?.name
        });
    });

    // Heartbeat to keep connection alive
    socket.on('ping', () => {
        socket.emit('pong');
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        peers: peers.size,
        uptime: process.uptime()
    });
});

// API to get active peers count
app.get('/api/peers', (req, res) => {
    res.json({
        count: peers.size,
        peers: Array.from(peers.values())
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════╗
║   AirDrop Web - Signaling Server         ║
║   Running on port ${PORT}                    ║
║   http://localhost:${PORT}                   ║
╚═══════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    // console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
