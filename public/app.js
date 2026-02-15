class Storage {
    constructor() {
        this.dbName = 'FileSharingDB';
        this.dbVersion = 3;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                let store;
                if (!db.objectStoreNames.contains('chunks')) {
                    store = db.createObjectStore('chunks', { keyPath: 'id' });
                } else {
                    store = event.target.transaction.objectStore('chunks');
                }

                if (!store.indexNames.contains('transferId')) {
                    store.createIndex('transferId', 'transferId', { unique: false });
                }
            };
        });
    }

    async saveChunk(transferId, chunkIndex, data) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['chunks'], 'readwrite');
            const store = transaction.objectStore('chunks');
            const id = `${transferId}-${chunkIndex}`;
            store.put({ id, transferId, chunkIndex, data });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async getChunks(transferId) {
        return new Promise((resolve, reject) => {
            if (!this.db) return resolve([]);
            const transaction = this.db.transaction(['chunks'], 'readonly');
            const store = transaction.objectStore('chunks');
            if (!store.indexNames.contains('transferId')) {
                return resolve([]);
            }
            const index = store.index('transferId');
            const request = index.openCursor(IDBKeyRange.only(transferId));
            const chunks = [];
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    chunks.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(chunks.sort((a, b) => a.chunkIndex - b.chunkIndex).map(c => c.data));
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteChunks(transferId) {
        return new Promise((resolve, reject) => {
            if (!this.db) return resolve();
            const transaction = this.db.transaction(['chunks'], 'readwrite');
            const store = transaction.objectStore('chunks');
            if (!store.indexNames.contains('transferId')) {
                return resolve();
            }
            const index = store.index('transferId');
            const request = index.openKeyCursor(IDBKeyRange.only(transferId));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getProgress(transferId) {
        return new Promise((resolve, reject) => {
            if (!this.db) return resolve(0);
            try {
                const transaction = this.db.transaction(['chunks'], 'readonly');
                const store = transaction.objectStore('chunks');
                if (!store.indexNames.contains('transferId')) {
                    return resolve(0);
                }
                const index = store.index('transferId');
                const request = index.count(IDBKeyRange.only(transferId));
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            } catch (error) {
                console.error('Error in getProgress:', error);
                resolve(0);
            }
        });
    }
}

class FileSharingApp {
    constructor() {
        this.socket = null;
        this.myId = null;
        this.peers = new Map();
        this.connections = new Map(); // WebRTC connections
        this.dataChannels = new Map(); // Data channels for file transfer
        this.transfers = [];
        this.selectedPeer = null;
        this.pendingTransfers = new Map(); // Pending file acceptance
        this.activeModal = null;
        this.storage = new Storage();
        this.incomingChunks = new Map(); // transferId -> { metadata, receivedSize }
        this.incomingQueue = []; // Queue for incoming file modals
        this.pendingBinaryChunks = new Map(); // transferId -> ArrayBuffer[]
        this.renderRequested = false;

        // WebRTC configuration
        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };

        // Large file support
        this.CHUNK_SIZE = 65536; // 64KB
        this.MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB

        this.init();
    }

    async init() {
        await this.storage.init();
        this.connectToSignalingServer();
        this.setupFileHandling();
        this.detectDevice();
    }

    connectToSignalingServer() {
        this.socket = io();
        this.socket.on('connect', () => {
            this.myId = this.socket.id;
            this.updateStatus(true);
            document.getElementById('yourId').textContent = this.myId.substring(0, 6).toUpperCase();
            this.socket.emit('register', {
                name: this.deviceName,
                device: this.deviceType,
                icon: this.deviceIcon
            });
        });

        this.socket.on('disconnect', () => {
            this.updateStatus(false);
            this.peers.clear();
            this.renderPeers();
        });

        this.socket.on('peers-list', (peerList) => {
            peerList.forEach(peer => this.addPeer(peer));
        });

        this.socket.on('peer-joined', (peer) => {
            this.addPeer(peer);
            this.showNotification('Device Connected', `${peer.name} is now available`);
        });

        this.socket.on('peer-left', (data) => {
            this.removePeer(data.id);
            this.showNotification('Device Disconnected', `${data.name} left`);
        });

        this.socket.on('webrtc-offer', async (data) => await this.handleOffer(data));
        this.socket.on('webrtc-answer', async (data) => await this.handleAnswer(data));
        this.socket.on('ice-candidate', async (data) => await this.handleIceCandidate(data));

        this.socket.on('file-incoming', (data) => this.showFileIncomingModal(data));

        this.socket.on('file-accepted', (data) => {
            const transfer = this.pendingTransfers.get(data.transferId);
            if (transfer) {
                this.showNotification('Transfer Starting', `${transfer.fileName} accepted`);
                this.startFileTransfer(transfer, data.resOffset || 0);
                this.pendingTransfers.delete(data.transferId);
            }
        });

        this.socket.on('file-rejected', (data) => {
            const transfer = this.pendingTransfers.get(data.transferId);
            if (transfer) {
                this.showNotification('Transfer Declined', data.reason);
                this.removeTransfer(data.transferId);
                this.pendingTransfers.delete(data.transferId);
            }
        });
    }

    detectDevice() {
        const ua = navigator.userAgent;
        this.deviceIcon = '🌐';
        this.deviceType = 'Browser';
        this.deviceName = 'Browser';

        if (/Win/.test(ua)) { this.deviceType = 'Windows PC'; this.deviceIcon = '💻'; this.deviceName = 'PC'; }
        else if (/Mac/.test(ua)) { this.deviceType = 'Mac'; this.deviceIcon = '🖥️'; this.deviceName = 'MacBook'; }
        else if (/Android/.test(ua)) { this.deviceType = 'Android'; this.deviceIcon = '📱'; this.deviceName = 'Phone'; }
        else if (/iPhone|iPad|iPod/.test(ua)) { this.deviceType = 'iOS Device'; this.deviceIcon = '📱'; this.deviceName = 'iPhone'; }
    }

    updateStatus(connected) {
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        if (connected) {
            statusDot.classList.remove('offline');
            statusText.textContent = 'Connected';
        } else {
            statusDot.classList.add('offline');
            statusText.textContent = 'Offline';
        }
    }

    addPeer(peer) {
        if (peer.id === this.myId) return;
        this.peers.set(peer.id, peer);
        this.renderPeers();
    }

    removePeer(id) {
        this.peers.delete(id);
        this.connections.delete(id);
        this.dataChannels.delete(id);
        this.renderPeers();
    }

    renderPeers() {
        const grid = document.getElementById('peersGrid');
        if (this.peers.size === 0) {
            grid.innerHTML = '<div class="empty-state">Searching for nearby devices...</div>';
            return;
        }
        grid.innerHTML = Array.from(this.peers.entries()).map(([id, peer]) => `
            <div class="peer-card" onclick="app.selectPeer('${id}')">
                <div class="peer-name">${peer.icon} ${peer.name} (${peer.device})</div>
            </div>
        `).join('');
    }

    async selectPeer(peerId) {
        this.selectedPeer = peerId;
        if (!this.connections.has(peerId)) await this.createConnection(peerId);
        document.getElementById('fileInput').click();
    }

    async createConnection(peerId) {
        try {
            const pc = new RTCPeerConnection(this.rtcConfig);
            this.connections.set(peerId, pc);
            pc.onicecandidate = (event) => {
                if (event.candidate) this.socket.emit('ice-candidate', { targetId: peerId, candidate: event.candidate });
            };
            const dataChannel = pc.createDataChannel('fileTransfer', { ordered: true });
            this.setupDataChannel(dataChannel, peerId);
            this.dataChannels.set(peerId, dataChannel);

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.socket.emit('webrtc-offer', { targetId: peerId, offer: offer });
        } catch (error) {
            console.error('Error creating connection:', error);
        }
    }

    async handleOffer(data) {
        try {
            const pc = new RTCPeerConnection(this.rtcConfig);
            this.connections.set(data.senderId, pc);
            pc.onicecandidate = (event) => {
                if (event.candidate) this.socket.emit('ice-candidate', { targetId: data.senderId, candidate: event.candidate });
            };
            pc.ondatachannel = (event) => {
                this.setupDataChannel(event.channel, data.senderId);
                this.dataChannels.set(data.senderId, event.channel);
            };
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.socket.emit('webrtc-answer', { targetId: data.senderId, answer: answer });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    async handleAnswer(data) {
        const pc = this.connections.get(data.senderId);
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }

    async handleIceCandidate(data) {
        const pc = this.connections.get(data.senderId);
        if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }

    setupDataChannel(channel, peerId) {
        channel.binaryType = 'arraybuffer';
        channel.onmessage = async (event) => {
            if (typeof event.data === 'string') {
                const message = JSON.parse(event.data);
                if (message.type === 'metadata') {
                    const metadata = message.data;
                    const existingChunks = await this.storage.getProgress(metadata.transferId);
                    const resOffset = existingChunks * this.CHUNK_SIZE;

                    this.incomingChunks.set(metadata.transferId, {
                        metadata,
                        receivedSize: resOffset,
                        savedChunks: existingChunks,
                        completed: false
                    });

                    if (!this.transfers.find(t => t.id === metadata.transferId)) {
                        this.transfers.push({
                            id: metadata.transferId, fileName: metadata.name, fileSize: metadata.size,
                            fileType: metadata.type, peerId, progress: (resOffset / metadata.size) * 100,
                            status: 'receiving', direction: 'incoming'
                        });
                        this.renderTransfers();
                    }

                    if (this.pendingBinaryChunks.has(metadata.transferId)) {
                        const buffered = this.pendingBinaryChunks.get(metadata.transferId);
                        this.pendingBinaryChunks.delete(metadata.transferId);
                        for (const chunk of buffered) await this.processChunk(metadata.transferId, chunk, this.incomingChunks.get(metadata.transferId));
                    }
                }
            } else {
                const view = new DataView(event.data);
                const idLength = view.getUint8(0);
                const transferId = new TextDecoder().decode(event.data.slice(1, 1 + idLength));
                const chunkData = event.data.slice(1 + idLength);

                const incoming = this.incomingChunks.get(transferId);
                if (incoming) await this.processChunk(transferId, chunkData, incoming);
                else {
                    if (!this.pendingBinaryChunks.has(transferId)) this.pendingBinaryChunks.set(transferId, []);
                    this.pendingBinaryChunks.get(transferId).push(chunkData);
                }
            }
        };
    }

    async processChunk(transferId, chunkData, incoming) {
        if (incoming.completed) return;

        const currentOffset = incoming.receivedSize;
        incoming.receivedSize += chunkData.byteLength;
        const chunkIndex = Math.floor(currentOffset / this.CHUNK_SIZE);

        await this.storage.saveChunk(transferId, chunkIndex, chunkData);
        incoming.savedChunks++;

        const progress = (incoming.receivedSize / incoming.metadata.size) * 100;
        this.updateTransferProgress(transferId, progress);

        // Check completion using both size and chunk count for maximum reliability
        const totalExpectedChunks = Math.ceil(incoming.metadata.size / this.CHUNK_SIZE);
        if (incoming.receivedSize >= incoming.metadata.size && incoming.savedChunks >= totalExpectedChunks) {
            incoming.completed = true;
            try {
                const chunks = await this.storage.getChunks(transferId);
                const blob = new Blob(chunks, { type: incoming.metadata.type });
                this.downloadFile(blob, incoming.metadata.name);
                this.updateTransferStatus(transferId, 'completed');
                this.showNotification('Transfer Complete', `Received ${incoming.metadata.name}`);
                await this.storage.deleteChunks(transferId);
                this.incomingChunks.delete(transferId);
            } catch (error) {
                console.error('Error assembling file:', error);
                incoming.completed = false; // Allow retry or error state
                this.updateTransferStatus(transferId, 'error');
            }
        }
    }

    setupFileHandling() {
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('active'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('active'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault(); dropZone.classList.remove('active');
            this.handleFiles(Array.from(e.dataTransfer.files));
        });
        fileInput.addEventListener('change', (e) => {
            this.handleFiles(Array.from(e.target.files));
            fileInput.value = '';
        });
    }

    async handleFiles(files) {
        if (files.length === 0 || !this.selectedPeer) return;
        for (const file of files) {
            if (file.size > this.MAX_FILE_SIZE) {
                this.showNotification('File Too Large', `${file.name} is over 5GB`);
                continue;
            }
            this.sendFile(file, this.selectedPeer);
        }
    }

    async sendFile(file, peerId) {
        const channel = this.dataChannels.get(peerId);
        if (!channel || channel.readyState !== 'open') return;

        const signature = btoa(file.name + file.size + (file.lastModified || '')).substring(0, 24);
        let transferId = signature;

        // Ensure unique ID for concurrent transfers of identical files
        let counter = 1;
        while (this.transfers.find(t => t.id === transferId) || this.pendingTransfers.has(transferId)) {
            transferId = `${signature}-${counter++}`;
        }

        this.socket.emit('file-metadata', { targetId: peerId, fileName: file.name, fileSize: file.size, fileType: file.type, transferId });

        const transfer = {
            id: transferId, fileName: file.name, fileSize: file.size, fileType: file.type, file,
            peerId, progress: 0, status: 'waiting', direction: 'outgoing', channel
        };
        this.pendingTransfers.set(transferId, transfer);
        this.transfers.push(transfer);
        this.renderTransfers();
    }

    async startFileTransfer(transfer, startOffset = 0) {
        const { file, channel, id: transferId } = transfer;
        this.updateTransferStatus(transferId, 'sending');
        channel.send(JSON.stringify({ type: 'metadata', data: { name: file.name, size: file.size, type: file.type, transferId } }));

        let offset = startOffset;
        const sendNextChunk = () => {
            if (transfer.status === 'error' || transfer.status === 'completed') return;
            if (channel.bufferedAmount > 1024 * 1024) { setTimeout(sendNextChunk, 50); return; }
            if (offset >= file.size) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                const idBytes = new TextEncoder().encode(transferId);
                const chunkData = new Uint8Array(e.target.result);
                const packet = new Uint8Array(1 + idBytes.length + chunkData.length);
                packet[0] = idBytes.length; packet.set(idBytes, 1); packet.set(chunkData, 1 + idBytes.length);
                channel.send(packet);
                offset += chunkData.length;
                this.updateTransferProgress(transferId, (offset / file.size) * 100);
                if (offset < file.size) setTimeout(sendNextChunk, 0);
                else { this.updateTransferStatus(transferId, 'completed'); this.showNotification('Sent', file.name); }
            };
            reader.readAsArrayBuffer(file.slice(offset, offset + this.CHUNK_SIZE));
        };
        sendNextChunk();
    }

    downloadFile(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    updateTransferProgress(transferId, progress) {
        const t = this.transfers.find(t => t.id === transferId);
        if (t) { t.progress = Math.min(progress, 100); this.renderTransfers(); }
    }

    updateTransferStatus(transferId, status) {
        const t = this.transfers.find(t => t.id === transferId);
        if (t) { t.status = status; this.renderTransfers(); }
    }

    removeTransfer(transferId) {
        const idx = this.transfers.findIndex(t => t.id === transferId);
        if (idx !== -1) { this.transfers.splice(idx, 1); this.renderTransfers(); }
    }

    renderTransfers() {
        if (this.renderRequested) return;
        this.renderRequested = true;
        requestAnimationFrame(() => { this.doRenderTransfers(); this.renderRequested = false; });
    }

    doRenderTransfers() {
        const list = document.getElementById('transferList');
        const items = document.getElementById('transferItems');
        if (this.transfers.length === 0) { list.style.display = 'none'; return; }
        list.style.display = 'block';
        items.innerHTML = this.transfers.map(t => {
            const peer = this.peers.get(t.peerId);
            const statusLabel = t.status === 'completed' ? '✓ Complete' : t.status === 'error' ? '✗ Failed' : t.status === 'waiting' ? '⏳ Waiting' : (t.direction === 'outgoing' ? '↻ Sending' : '↻ Receiving');
            return `<div class="transfer-item"><div class="transfer-info"><div class="transfer-name">${t.fileName}</div><div class="transfer-status">${statusLabel} ${t.direction === 'outgoing' ? 'to' : 'from'} ${peer ? peer.name : 'Device'} (${this.formatFileSize(t.fileSize)})</div><div class="transfer-progress"><div class="transfer-progress-bar" style="width: ${t.progress}%"></div></div></div></div>`;
        }).join('');
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    showFileIncomingModal(data) {
        this.incomingQueue.push(data);
        if (!this.activeModal) this.processIncomingQueue();
    }

    async processIncomingQueue() {
        if (this.incomingQueue.length === 0) return;
        const data = this.incomingQueue[0];
        const peer = this.peers.get(data.senderId);
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `<div class="modal-content"><div class="modal-title">📥 Incoming File</div><p><strong>${peer ? peer.name : 'Unknown'}</strong> wants to send ${data.fileName}</p><div class="modal-buttons"><button class="btn btn-danger" id="rejectBtn">Decline</button><button class="btn btn-secondary" id="acceptAllBtn" style="display: ${this.incomingQueue.length > 1 ? 'block' : 'none'}">Accept All</button><button class="btn btn-primary" id="acceptBtn">Accept</button></div></div>`;
        document.body.appendChild(modal);
        this.activeModal = modal;

        const handleAccept = async (item) => {
            try {
                const existingChunks = await this.storage.getProgress(item.transferId);
                const resOffset = existingChunks * this.CHUNK_SIZE;

                this.socket.emit('file-accept', {
                    senderId: item.senderId,
                    transferId: item.transferId,
                    resOffset
                });

                const existingTransfer = this.transfers.find(t => t.id === item.transferId);
                if (!existingTransfer) {
                    this.transfers.push({
                        id: item.transferId,
                        fileName: item.fileName,
                        fileSize: item.fileSize,
                        peerId: item.senderId,
                        progress: (resOffset / item.fileSize) * 100,
                        status: 'receiving',
                        direction: 'incoming'
                    });
                } else {
                    existingTransfer.status = 'receiving';
                    existingTransfer.progress = (resOffset / item.fileSize) * 100;
                }
                this.renderTransfers();
            } catch (error) {
                console.error('Error in handleAccept:', error);
                this.showNotification('Error', 'Failed to accept file transfer');
            }
        };

        document.getElementById('acceptBtn').onclick = async () => {
            try {
                await handleAccept(data);
            } catch (error) {
                console.error('Crash in Accept handler:', error);
                this.showNotification('Error', 'Failed to accept file transfer');
            }
            modal.remove();
            this.activeModal = null;
            this.incomingQueue.shift();
            this.processIncomingQueue();
        };

        const acceptAllBtn = document.getElementById('acceptAllBtn');
        if (acceptAllBtn) {
            acceptAllBtn.onclick = async () => {
                try {
                    for (const item of this.incomingQueue) {
                        await handleAccept(item);
                    }
                } catch (error) {
                    console.error('Crash in Accept All handler:', error);
                    this.showNotification('Error', 'Some transfers failed to start');
                }
                this.incomingQueue = [];
                modal.remove();
                this.activeModal = null;
            };
        }

        document.getElementById('rejectBtn').onclick = () => {
            this.socket.emit('file-reject', {
                senderId: data.senderId,
                transferId: data.transferId,
                reason: 'Declined'
            });
            modal.remove();
            this.activeModal = null;
            this.incomingQueue.shift();
            this.processIncomingQueue();
        };
    }

    showNotification(title, body) {
        const n = document.createElement('div'); n.className = 'notification';
        n.innerHTML = `<div class="notification-title">${title}</div><div class="notification-body">${body}</div>`;
        document.body.appendChild(n);
        setTimeout(() => { n.style.animation = 'slideInRight 0.3s ease-out reverse'; setTimeout(() => n.remove(), 300); }, 3000);
    }
}

const app = new FileSharingApp();
