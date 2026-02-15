class Storage {
    constructor() {
        this.dbName = 'FileSharingDB';
        this.dbVersion = 2;
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
                if (!db.objectStoreNames.contains('chunks')) {
                    const store = db.createObjectStore('chunks', { keyPath: 'id' });
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
            const transaction = this.db.transaction(['chunks'], 'readonly');
            const store = transaction.objectStore('chunks');
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
            const transaction = this.db.transaction(['chunks'], 'readwrite');
            const store = transaction.objectStore('chunks');
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
            const transaction = this.db.transaction(['chunks'], 'readonly');
            const store = transaction.objectStore('chunks');
            const index = store.index('transferId');
            const request = index.count(IDBKeyRange.only(transferId));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
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

        // WebRTC configuration
        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };

        // Large file support - 64KB chunks for better performance with large files
        this.CHUNK_SIZE = 65536; // 64KB chunks (up to 5GB support)
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
        // Connect to signaling server
        this.socket = io();

        this.socket.on('connect', () => {
            this.myId = this.socket.id;
            this.updateStatus(true);
            document.getElementById('yourId').textContent = this.myId.substring(0, 6).toUpperCase();

            // Register this peer
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

        // Receive list of existing peers
        this.socket.on('peers-list', (peerList) => {
            peerList.forEach(peer => {
                this.addPeer(peer);
            });
        });

        // New peer joined
        this.socket.on('peer-joined', (peer) => {
            this.addPeer(peer);
            this.showNotification('Device Connected', `${peer.name} is now available`);
        });

        // Peer left
        this.socket.on('peer-left', (data) => {
            this.removePeer(data.id);
            this.showNotification('Device Disconnected', `${data.name} left`);
        });

        // WebRTC Signaling
        this.socket.on('webrtc-offer', async (data) => {
            await this.handleOffer(data);
        });

        this.socket.on('webrtc-answer', async (data) => {
            await this.handleAnswer(data);
        });

        this.socket.on('ice-candidate', async (data) => {
            await this.handleIceCandidate(data);
        });

        // File incoming notification
        this.socket.on('file-incoming', (data) => {
            this.showFileIncomingModal(data);
        });

        // File accepted by receiver
        this.socket.on('file-accepted', (data) => {
            const transfer = this.pendingTransfers.get(data.transferId);
            if (transfer) {
                this.showNotification('Transfer Starting', `${transfer.fileName} accepted`);
                this.startFileTransfer(transfer, data.resOffset || 0);
                this.pendingTransfers.delete(data.transferId);
            }
        });

        // File rejected by receiver
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

        if (/iPhone|iPad|iPod/.test(ua)) {
            this.deviceType = 'iOS Device';
            this.deviceIcon = '📱';
            this.deviceName = /iPad/.test(ua) ? 'iPad' : 'iPhone';
        } else if (/Android/.test(ua)) {
            this.deviceType = 'Android';
            this.deviceIcon = '📱';
            this.deviceName = 'Samsung Galaxy S21';
        } else if (/Mac/.test(ua)) {
            this.deviceType = 'Mac';
            this.deviceIcon = '🖥️';
            this.deviceName = 'MacBook';
        } else if (/Win/.test(ua)) {
            this.deviceType = 'Windows PC';
            this.deviceIcon = '💻';
            this.deviceName = 'PC';
        } else {
            this.deviceType = 'Browser';
            this.deviceIcon = '🌐';
            this.deviceName = 'Browser';
        }
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
            grid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📡</div>
                    <div class="empty-text">
                        Searching for nearby devices...<br>
                        <small>Open this page on another device to start sharing</small>
                    </div>
                </div>
            `;
            return;
        }

        grid.innerHTML = Array.from(this.peers.entries()).map(([id, peer]) => `
            <div class="peer-card" onclick="app.selectPeer('${id}')">
                <div class="peer-name">${peer.icon} ${peer.name} ${peer.device} ID: ${id.substring(0, 6).toUpperCase()}</div>
            </div>
        `).join('');
    }

    async selectPeer(peerId) {
        this.selectedPeer = peerId;

        // Establish WebRTC connection if not already connected
        if (!this.connections.has(peerId)) {
            await this.createConnection(peerId);
        }

        // Trigger file selection
        const fileInput = document.getElementById('fileInput');
        fileInput.click();
    }

    async createConnection(peerId) {
        try {
            // Create RTCPeerConnection
            const pc = new RTCPeerConnection(this.rtcConfig);
            this.connections.set(peerId, pc);

            // Handle ICE candidates
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    this.socket.emit('ice-candidate', {
                        targetId: peerId,
                        candidate: event.candidate
                    });
                }
            };

            // Create data channel
            const dataChannel = pc.createDataChannel('fileTransfer', {
                ordered: true
            });

            this.setupDataChannel(dataChannel, peerId);
            this.dataChannels.set(peerId, dataChannel);

            // Create and send offer
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            this.socket.emit('webrtc-offer', {
                targetId: peerId,
                offer: offer
            });

        } catch (error) {
            console.error('Error creating connection:', error);
            this.showNotification('Connection Error', 'Failed to connect to peer');
        }
    }

    async handleOffer(data) {
        try {
            const pc = new RTCPeerConnection(this.rtcConfig);
            this.connections.set(data.senderId, pc);

            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    this.socket.emit('ice-candidate', {
                        targetId: data.senderId,
                        candidate: event.candidate
                    });
                }
            };

            pc.ondatachannel = (event) => {
                this.setupDataChannel(event.channel, data.senderId);
                this.dataChannels.set(data.senderId, event.channel);
            };

            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            this.socket.emit('webrtc-answer', {
                targetId: data.senderId,
                answer: answer
            });

        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    async handleAnswer(data) {
        try {
            const pc = this.connections.get(data.senderId);
            if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            }
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(data) {
        try {
            const pc = this.connections.get(data.senderId);
            if (pc) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        } catch (error) {
            console.error('Error handling ICE candidate:', error);
        }
    }

    setupDataChannel(channel, peerId) {
        channel.binaryType = 'arraybuffer';
        let fileMetadata = null;

        channel.onopen = () => {
            console.log('Data channel opened with', peerId);
        };

        channel.onmessage = async (event) => {
            if (typeof event.data === 'string') {
                const message = JSON.parse(event.data);

                if (message.type === 'metadata') {
                    const metadata = message.data;
                    console.log('Received file metadata:', metadata);

                    // Check for existing progress
                    const existingChunks = await this.storage.getProgress(metadata.transferId);
                    const resOffset = existingChunks * this.CHUNK_SIZE;

                    this.incomingChunks.set(metadata.transferId, {
                        metadata,
                        receivedSize: resOffset
                    });

                    // Add to transfer list if not there (for resumption)
                    if (!this.transfers.find(t => t.id === metadata.transferId)) {
                        this.transfers.push({
                            id: metadata.transferId,
                            fileName: metadata.name,
                            fileSize: metadata.size,
                            fileType: metadata.type,
                            peerId,
                            progress: (resOffset / metadata.size) * 100,
                            status: 'receiving',
                            direction: 'incoming'
                        });
                        this.renderTransfers();
                    }
                }
            } else {
                // Handle binary chunk (multiplexed)
                const view = new DataView(event.data);
                const idLength = view.getUint8(0);
                const decoder = new TextDecoder();
                const transferId = decoder.decode(event.data.slice(1, 1 + idLength));
                const chunkData = event.data.slice(1 + idLength);

                const incoming = this.incomingChunks.get(transferId);
                if (incoming) {
                    // Update size synchronously to avoid race condition
                    const currentOffset = incoming.receivedSize;
                    incoming.receivedSize += chunkData.byteLength;

                    const chunkIndex = Math.floor(currentOffset / this.CHUNK_SIZE);
                    await this.storage.saveChunk(transferId, chunkIndex, chunkData);

                    const progress = (incoming.receivedSize / incoming.metadata.size) * 100;
                    this.updateTransferProgress(transferId, progress);

                    if (incoming.receivedSize >= incoming.metadata.size) {
                        // File complete
                        const chunks = await this.storage.getChunks(transferId);
                        const blob = new Blob(chunks, { type: incoming.metadata.type });
                        this.downloadFile(blob, incoming.metadata.name);
                        this.updateTransferStatus(transferId, 'completed');
                        this.showNotification('Transfer Complete', `Received ${incoming.metadata.name}`);

                        // Clean up
                        await this.storage.deleteChunks(transferId);
                        this.incomingChunks.delete(transferId);
                    }
                }
            }
        };

        channel.onerror = (error) => {
            console.error('Data channel error:', error);
            this.showNotification('Transfer Error', 'Connection error occurred');
        };

        channel.onclose = () => {
            console.log('Data channel closed');
        };
    }

    setupFileHandling() {
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('active');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('active');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('active');
            const files = Array.from(e.dataTransfer.files);
            this.handleFiles(files);
        });

        fileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            this.handleFiles(files);
            fileInput.value = '';
        });
    }

    async handleFiles(files) {
        if (files.length === 0) return;

        if (!this.selectedPeer) {
            if (this.peers.size > 0) {
                this.showNotification('Select a Device', 'Click on a device to send files');
            } else {
                this.showNotification('No Devices', 'No devices available to send files to');
            }
            return;
        }

        // Validate file sizes
        for (const file of files) {
            if (file.size > this.MAX_FILE_SIZE) {
                this.showNotification('File Too Large', `${file.name} exceeds 5GB limit`);
                return;
            }
        }

        // Ensure connection exists
        if (!this.connections.has(this.selectedPeer)) {
            await this.createConnection(this.selectedPeer);
            // Wait for connection to establish
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        for (const file of files) {
            this.sendFile(file, this.selectedPeer);
        }
    }

    async sendFile(file, peerId) {
        const channel = this.dataChannels.get(peerId);

        if (!channel || channel.readyState !== 'open') {
            this.showNotification('Connection Error', 'Not connected to peer');
            return;
        }

        // Generate stable signature for resumption (name + size + lastModified)
        const signature = btoa(file.name + file.size + (file.lastModified || '')).substring(0, 24);
        const transferId = signature;

        // Notify recipient about incoming file (requires acceptance)
        this.socket.emit('file-metadata', {
            targetId: peerId,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            transferId: transferId
        });

        // Add to pending transfers (waiting for acceptance)
        const transfer = {
            id: transferId,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            file: file,
            peerId: peerId,
            progress: 0,
            status: 'waiting',
            direction: 'outgoing',
            channel: channel
        };

        this.pendingTransfers.set(transferId, transfer);
        this.transfers.push(transfer);
        this.renderTransfers();
    }

    async startFileTransfer(transfer, startOffset = 0) {
        const { file, channel, id: transferId } = transfer;

        // Update status
        this.updateTransferStatus(transferId, 'sending');

        // Send metadata via data channel
        const metadata = {
            type: 'metadata',
            data: {
                name: file.name,
                size: file.size,
                type: file.type,
                transferId: transferId
            }
        };
        channel.send(JSON.stringify(metadata));

        // Send file in larger chunks (64KB)
        const chunkSize = this.CHUNK_SIZE;
        let offset = startOffset;

        const sendNextChunk = () => {
            if (transfer.status === 'error' || transfer.status === 'completed') return;

            // Flow control: Wait if buffer is too full
            if (channel.bufferedAmount > 1024 * 1024) { // 1MB threshold
                setTimeout(sendNextChunk, 50);
                return;
            }

            if (offset >= file.size) {
                this.updateTransferStatus(transferId, 'completed');
                this.showNotification('Transfer Complete', `${file.name} sent successfully`);
                return;
            }

            const slice = file.slice(offset, offset + chunkSize);
            const reader = new FileReader();

            reader.onload = (e) => {
                try {
                    const encoder = new TextEncoder();
                    const idBytes = encoder.encode(transferId);
                    const chunkData = new Uint8Array(e.target.result);

                    const packet = new Uint8Array(1 + idBytes.length + chunkData.length);
                    packet[0] = idBytes.length;
                    packet.set(idBytes, 1);
                    packet.set(chunkData, 1 + idBytes.length);

                    channel.send(packet);

                    offset += chunkData.length;

                    const progress = (offset / file.size) * 100;
                    this.updateTransferProgress(transferId, progress);

                    if (offset < file.size) {
                        // Parallel-friendly scheduling
                        setTimeout(sendNextChunk, 0);
                    } else {
                        this.updateTransferStatus(transferId, 'completed');
                        this.showNotification('Transfer Complete', `${file.name} sent successfully`);
                    }
                } catch (error) {
                    console.error('Error sending chunk:', error);
                    this.updateTransferStatus(transferId, 'error');
                }
            };

            reader.onerror = () => {
                this.updateTransferStatus(transferId, 'error');
            };

            reader.readAsArrayBuffer(slice);
        };

        sendNextChunk();
    }

    downloadFile(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    updateTransferProgress(transferId, progress) {
        const transfer = this.transfers.find(t => t.id === transferId);
        if (transfer) {
            transfer.progress = Math.min(progress, 100);
            this.renderTransfers();
        }
    }

    updateTransferStatus(transferId, status) {
        const transfer = this.transfers.find(t => t.id === transferId);
        if (transfer) {
            transfer.status = status;
            this.renderTransfers();
        }
    }

    removeTransfer(transferId) {
        const index = this.transfers.findIndex(t => t.id === transferId);
        if (index !== -1) {
            this.transfers.splice(index, 1);
            this.renderTransfers();
        }
    }

    renderTransfers() {
        const transferList = document.getElementById('transferList');
        const transferItems = document.getElementById('transferItems');

        if (this.transfers.length === 0) {
            transferList.style.display = 'none';
            return;
        }

        transferList.style.display = 'block';
        transferItems.innerHTML = this.transfers.map(t => {
            const peer = this.peers.get(t.peerId);
            const peerName = peer ? peer.name : 'Unknown';
            const direction = t.direction === 'outgoing' ? 'to' : 'from';

            let statusIcon = '↻';
            let statusLabel = t.direction === 'outgoing' ? 'Sending' : 'Receiving';

            if (t.status === 'completed') {
                statusIcon = '✓';
                statusLabel = 'Complete';
            } else if (t.status === 'waiting') {
                statusIcon = '⏳';
                statusLabel = 'Waiting for acceptance';
            } else if (t.status === 'error') {
                statusIcon = '✗';
                statusLabel = 'Failed';
            }

            return `
                <div class="transfer-item">
                    <div class="transfer-info">
                        <div class="transfer-name">${t.fileName}</div>
                        <div class="transfer-status">
                            ${statusIcon} ${statusLabel} 
                            ${direction} ${peerName} 
                            (${this.formatFileSize(t.fileSize)})
                        </div>
                        <div class="transfer-progress">
                            <div class="transfer-progress-bar" style="width: ${t.progress}%"></div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    showFileIncomingModal(data) {
        this.incomingQueue.push(data);
        if (!this.activeModal) {
            this.processIncomingQueue();
        }
    }

    async processIncomingQueue() {
        if (this.incomingQueue.length === 0) return;

        const data = this.incomingQueue[0];
        const peer = this.peers.get(data.senderId) || data.senderInfo;
        const peerName = peer ? peer.name : 'Unknown Device';

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-title">📥 Incoming File</div>
                <p style="color: var(--text-secondary); margin-bottom: 15px;">
                    <strong>${peerName}</strong> wants to send you a file
                </p>
                <div class="file-info">
                    <div class="file-info-item">
                        <span class="file-info-label">File Name:</span>
                        <span class="file-info-value">${data.fileName}</span>
                    </div>
                    <div class="file-info-item">
                        <span class="file-info-label">File Size:</span>
                        <span class="file-info-value">${this.formatFileSize(data.fileSize)}</span>
                    </div>
                    <div class="file-info-item">
                        <span class="file-info-label">File Type:</span>
                        <span class="file-info-value">${data.fileType || 'Unknown'}</span>
                    </div>
                </div>
                <div class="modal-buttons">
                    <button class="btn btn-danger" id="rejectBtn">Decline</button>
                    <button class="btn btn-primary" id="acceptBtn">Accept</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        this.activeModal = modal;

        // Add to transfer list as pending
        const transfer = {
            id: data.transferId,
            fileName: data.fileName,
            fileSize: data.fileSize,
            fileType: data.fileType,
            peerId: data.senderId,
            progress: 0,
            status: 'pending',
            direction: 'incoming'
        };
        this.transfers.push(transfer);
        this.renderTransfers();

        // Handle accept
        document.getElementById('acceptBtn').onclick = async () => {
            // Check if we already have chunks for this file
            const existingChunks = await this.storage.getProgress(data.transferId);
            const resOffset = existingChunks * this.CHUNK_SIZE;

            this.socket.emit('file-accept', {
                senderId: data.senderId,
                transferId: data.transferId,
                resOffset
            });

            // Update transfer status
            this.updateTransferStatus(data.transferId, 'receiving');

            if (resOffset > 0) {
                this.showNotification('Resuming Transfer', `Resuming ${data.fileName} from ${this.formatFileSize(resOffset)}...`);
            } else {
                this.showNotification('Transfer Starting', `Receiving ${data.fileName}...`);
            }
            modal.remove();
            this.activeModal = null;
            this.incomingQueue.shift();
            this.processIncomingQueue();
        };

        // Handle reject
        document.getElementById('rejectBtn').onclick = () => {
            this.socket.emit('file-reject', {
                senderId: data.senderId,
                transferId: data.transferId,
                reason: 'File declined by recipient'
            });

            // Remove from transfers
            this.removeTransfer(data.transferId);

            this.showNotification('File Declined', `Declined ${data.fileName}`);
            modal.remove();
            this.activeModal = null;
            this.incomingQueue.shift();
            this.processIncomingQueue();
        };

        // Close on background click
        modal.onclick = (e) => {
            if (e.target === modal) {
                document.getElementById('rejectBtn').click();
            }
        };
    }

    showNotification(title, body) {
        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.innerHTML = `
            <div class="notification-title">${title}</div>
            <div class="notification-body">${body}</div>
        `;
        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'slideInRight 0.3s ease-out reverse';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
}

// Initialize app
const app = new FileSharingApp();
