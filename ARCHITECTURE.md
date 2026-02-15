# System Architecture

## High-Level Overview

```
┌─────────────┐         ┌─────────────┐
│   Device A  │         │   Device B  │
│  (Browser)  │         │  (Browser)  │
└──────┬──────┘         └──────┬──────┘
       │                       │
       │  WebSocket (Signaling)│
       │                       │
       └───────┬───────────────┘
               │
       ┌───────▼────────┐
       │ Signaling      │
       │ Server         │
       │ (Node.js +     │
       │  Socket.IO)    │
       └────────────────┘
               │
       ┌───────▼────────┐
       │ STUN Server    │
       │ (Google)       │
       └────────────────┘

After connection established:

┌─────────────┐ ◄──WebRTC P2P──► ┌─────────────┐
│   Device A  │    Data Channel   │   Device B  │
│  (Browser)  │   (File Transfer) │  (Browser)  │
└─────────────┘                   └─────────────┘
```

## Detailed Flow

### 1. Initial Connection
```
User Opens App
      │
      ▼
Connect to Socket.IO Server
      │
      ▼
Receive Unique ID
      │
      ▼
Register Device Info
      │
      ▼
Receive List of Peers
```

### 2. Peer Discovery
```
Device A Connects              Device B Connects
      │                              │
      ▼                              ▼
Server Notifies Device B    ◄────────┤
      │                              │
      ▼                              ▼
Device B Notifies Device A  ────────►│
      │                              │
      ▼                              ▼
Both Devices See Each Other
```

### 3. WebRTC Connection Setup
```
Device A Selects Device B
      │
      ▼
Create RTCPeerConnection
      │
      ▼
Create Data Channel
      │
      ▼
Generate SDP Offer
      │
      ▼
Send Offer via Socket.IO ──────────► Device B
                                       │
                                       ▼
                           Receive Offer
                                       │
                                       ▼
                           Create RTCPeerConnection
                                       │
                                       ▼
                           Generate SDP Answer
                                       │
                                       ▼
Device A ◄────────────────── Send Answer via Socket.IO
      │
      ▼
Exchange ICE Candidates
      │
      ▼
P2P Connection Established!
```

### 4. File Transfer
```
Device A Selects File
      │
      ▼
Send File Metadata (via signaling)
      │                              
      ▼                              Device B
Notify Recipient          ──────────► Shows Notification
      │
      ▼
Split File into 16KB Chunks
      │
      ▼
Send via WebRTC Data Channel ──────► Device B
      │                                │
      │                                ▼
      │                       Receive & Buffer Chunks
      │                                │
      │                                ▼
      │                       Update Progress Bar
      │                                │
      └──────────────────────────────► │
                                       ▼
                              File Complete!
                                       │
                                       ▼
                              Auto-Download
```

## Technology Stack

### Frontend
- **HTML5/CSS3**: Modern responsive design
- **Vanilla JavaScript**: No framework bloat
- **WebRTC API**: Peer-to-peer connections
- **Socket.IO Client**: Real-time signaling
- **FileReader API**: File handling
- **Blob API**: File reconstruction

### Backend
- **Node.js**: Runtime environment
- **Express**: Web server
- **Socket.IO**: WebSocket server
- **HTTP**: Server creation

### Network
- **WebRTC**: P2P data transfer
- **ICE**: Connection negotiation
- **STUN**: NAT traversal
- **TURN**: Relay fallback (optional)

## Data Flow

### Signaling (Through Server)
```
┌────────────┐
│ Socket.IO  │
│  Messages  │
├────────────┤
│ register   │ ← Device info
│ peers-list │ ← All connected peers
│ peer-joined│ ← New peer notification
│ peer-left  │ ← Peer disconnect
│ offer      │ ← WebRTC SDP offer
│ answer     │ ← WebRTC SDP answer
│ ice-cand   │ ← ICE candidates
└────────────┘
```

### File Transfer (P2P)
```
┌──────────────┐
│ Data Channel │
├──────────────┤
│ Metadata     │ ← File info (JSON)
│ Chunk 1      │ ← Binary data
│ Chunk 2      │ ← Binary data
│ Chunk 3      │ ← Binary data
│ ...          │
│ Chunk N      │ ← Binary data
└──────────────┘
```

## Security Model

### What's Secure
✅ Files never touch the server
✅ Direct peer-to-peer transfer
✅ HTTPS encrypts signaling
✅ WebRTC encrypts data channel (DTLS)

### What Could Be Improved
⚠️ Add end-to-end encryption on top of DTLS
⚠️ Add authentication/authorization
⚠️ Add file integrity checks (checksums)

## Scalability

### Current Design
- **Signaling Server**: Handles connection coordination
- **No File Storage**: Zero storage costs
- **No Bandwidth**: Server doesn't transfer files
- **Horizontal Scaling**: Add more signaling servers with load balancer

### Bottleneck
- **Server Connection**: All peers must connect to signaling server
- **Solution**: Use sticky sessions or Redis adapter for Socket.IO

### Performance
- **File Size**: No server-side limit (limited by browser RAM)
- **Transfer Speed**: Limited by peer connection (~1-10 MB/s typical)
- **Concurrent Transfers**: No server limit (handled P2P)
- **Connections**: Node.js can handle ~10,000 WebSocket connections per server

## Network Requirements

### Minimum
- WebSocket support (all modern browsers)
- UDP support (for WebRTC)
- STUN server access

### Optimal
- TURN server (for NAT traversal)
- Low latency connection
- Stable network

### Firewall Configuration
Most corporate firewalls block WebRTC. Solutions:
1. Use TURN server as relay
2. VPN to bypass restrictions
3. Use fallback to server-based transfer (not implemented)

## Comparison with Alternatives

### vs. ShareDrop
- ✅ Same P2P approach
- ✅ Open source (ShareDrop is closed)
- ⚠️ Less battle-tested

### vs. WeTransfer
- ✅ No file size limits
- ✅ No storage on servers
- ✅ Faster for local transfers
- ⚠️ Requires both parties online simultaneously

### vs. Dropbox/Google Drive
- ✅ No cloud storage needed
- ✅ Instant transfer
- ⚠️ No persistence
- ⚠️ Both parties must be online

## Future Architecture Considerations

### Potential Enhancements
1. **Room System**: Private sharing rooms with codes
2. **E2E Encryption**: Add encryption layer on top of DTLS
3. **Mobile Apps**: Native iOS/Android apps
4. **Desktop Apps**: Electron wrapper
5. **Resume Capability**: Save transfer state
6. **Compression**: Compress files before transfer
7. **Multi-party**: Support 3+ peer transfers
8. **Mesh Network**: Allow file relay through peers

### Infrastructure
- Add Redis for multi-server coordination
- Implement load balancing
- Add monitoring (Prometheus/Grafana)
- Add logging (ELK stack)
- Deploy to edge locations (lower latency)
