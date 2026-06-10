const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ডাটা স্টোরেজ
const DATA_DIR = path.join(__dirname, 'data');
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');
const APPROVED_FILE = path.join(DATA_DIR, 'approved.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(REQUESTS_FILE)) fs.writeFileSync(REQUESTS_FILE, JSON.stringify([]));
if (!fs.existsSync(APPROVED_FILE)) fs.writeFileSync(APPROVED_FILE, JSON.stringify({}));
if (!fs.existsSync(DEVICES_FILE)) fs.writeFileSync(DEVICES_FILE, JSON.stringify({}));

// API Routes

// 1. ডিভাইস রেজিস্ট্রেশন ও প্রোফাইল সাবমিট
app.post('/api/register-device', (req, res) => {
    const { deviceId, deviceName, profiles, userName } = req.body;
    const devices = JSON.parse(fs.readFileSync(DEVICES_FILE));
    
    devices[deviceId] = {
        deviceName,
        userName: userName || 'Anonymous',
        profiles,
        lastSeen: new Date().toISOString()
    };
    
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
    res.json({ success: true, message: 'Device registered!' });
});

// 2. রিকোয়েস্ট সেন্ড
app.post('/api/request-access', (req, res) => {
    const { deviceId, deviceName, userName, profiles } = req.body;
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    
    const existing = requests.find(r => r.deviceId === deviceId && r.status === 'pending');
    if (existing) {
        return res.json({ success: false, message: 'Request already pending!' });
    }
    
    requests.push({
        deviceId,
        deviceName,
        userName: userName || 'Anonymous',
        profiles,
        status: 'pending',
        timestamp: new Date().toISOString()
    });
    
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
    io.emit('new-request', { deviceId, deviceName, userName });
    
    res.json({ success: true, message: 'Request sent to admin!' });
});

// 3. স্ট্যাটাস চেক
app.post('/api/check-status', (req, res) => {
    const { deviceId } = req.body;
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    
    const userApproved = approved[deviceId];
    const pendingRequest = requests.find(r => r.deviceId === deviceId && r.status === 'pending');
    
    if (userApproved) {
        res.json({ status: 'approved', expiresAt: userApproved.expiresAt });
    } else if (pendingRequest) {
        res.json({ status: 'pending' });
    } else {
        res.json({ status: 'none' });
    }
});

// 4. লঞ্চ কমান্ড পাওয়া
app.post('/api/get-commands', (req, res) => {
    const { deviceId } = req.body;
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    
    if (!approved[deviceId]) {
        return res.json({ success: false, message: 'Not approved!' });
    }
    
    const expiresAt = new Date(approved[deviceId].expiresAt);
    if (expiresAt < new Date()) {
        delete approved[deviceId];
        fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
        return res.json({ success: false, message: 'Access expired!' });
    }
    
    const pendingCommands = approved[deviceId].pendingCommands || [];
    approved[deviceId].pendingCommands = [];
    fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
    
    res.json({ success: true, commands: pendingCommands });
});

// 5. লঞ্চ রিকোয়েস্ট (UI থেকে)
app.post('/api/launch-request', (req, res) => {
    const { deviceId, numbers } = req.body;
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    
    if (!approved[deviceId]) {
        return res.json({ success: false, message: 'Not approved!' });
    }
    
    if (!approved[deviceId].pendingCommands) approved[deviceId].pendingCommands = [];
    approved[deviceId].pendingCommands.push({ type: 'launch', numbers, timestamp: Date.now() });
    fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
    
    res.json({ success: true, message: 'Launch command sent!' });
});

// 6. ডিভাইসের প্রোফাইল পাওয়া (UI দেখানোর জন্য)
app.post('/api/get-device-profiles', (req, res) => {
    const { deviceId } = req.body;
    const devices = JSON.parse(fs.readFileSync(DEVICES_FILE));
    
    if (devices[deviceId]) {
        res.json({ success: true, profiles: devices[deviceId].profiles });
    } else {
        res.json({ success: false, profiles: [] });
    }
});

// অ্যাডমিন APIs
app.get('/api/admin/requests', (req, res) => {
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    res.json(requests);
});

app.post('/api/admin/approve', (req, res) => {
    const { deviceId, hours, userName } = req.body;
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    
    const requestIndex = requests.findIndex(r => r.deviceId === deviceId);
    if (requestIndex !== -1) {
        requests[requestIndex].status = 'approved';
        fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
    }
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + parseInt(hours));
    
    approved[deviceId] = {
        deviceId,
        userName: userName || 'Unknown',
        approvedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        hours: hours,
        pendingCommands: []
    };
    
    fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
    io.emit('request-approved', { deviceId });
    
    res.json({ success: true });
});

app.post('/api/admin/reject', (req, res) => {
    const { deviceId } = req.body;
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    
    const requestIndex = requests.findIndex(r => r.deviceId === deviceId);
    if (requestIndex !== -1) {
        requests.splice(requestIndex, 1);
        fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
    }
    
    io.emit('request-rejected', { deviceId });
    res.json({ success: true });
});

// Serve HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});
