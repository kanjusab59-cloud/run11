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

// ডাটা ফোল্ডার
const DATA_DIR = path.join(__dirname, 'data');
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');
const APPROVED_FILE = path.join(DATA_DIR, 'approved.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

// ডাটা ফোল্ডার ও ফাইল তৈরি
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(REQUESTS_FILE)) fs.writeFileSync(REQUESTS_FILE, JSON.stringify([]));
if (!fs.existsSync(APPROVED_FILE)) fs.writeFileSync(APPROVED_FILE, JSON.stringify({}));
if (!fs.existsSync(DEVICES_FILE)) fs.writeFileSync(DEVICES_FILE, JSON.stringify({}));

console.log('✅ Server started');
console.log(`📁 Data folder: ${DATA_DIR}`);

// ==================== API ROUTES ====================

// 1. ডিভাইস রেজিস্ট্রেশন
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
    console.log(`✅ Device registered: ${deviceId} (${userName || 'Anonymous'})`);
    res.json({ success: true });
});

// 2. রিকোয়েস্ট সেন্ড
app.post('/api/request-access', (req, res) => {
    const { deviceId, deviceName, userName, profiles } = req.body;
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    
    // চেক করা ইতিমধ্যে পেন্ডিং রিকোয়েস্ট আছে কিনা
    const existing = requests.find(r => r.deviceId === deviceId && r.status === 'pending');
    if (existing) {
        return res.json({ success: false, message: 'Request already pending!' });
    }
    
    const newRequest = {
        deviceId,
        deviceName: deviceName || 'Unknown',
        userName: userName || 'Anonymous',
        profiles: profiles || [],
        status: 'pending',
        timestamp: new Date().toISOString()
    };
    
    requests.push(newRequest);
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
    
    // Socket.io নোটিফিকেশন
    io.emit('new-request', newRequest);
    
    console.log(`📨 New request from: ${userName || deviceId} (${deviceId})`);
    res.json({ success: true, message: 'Request sent to admin!' });
});

// 3. স্ট্যাটাস চেক
app.post('/api/check-status', (req, res) => {
    const { deviceId } = req.body;
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    
    console.log(`🔍 Status check for: ${deviceId}`);
    
    const userApproved = approved[deviceId];
    const pendingRequest = requests.find(r => r.deviceId === deviceId && r.status === 'pending');
    
    if (userApproved) {
        const expiresAt = new Date(userApproved.expiresAt);
        if (expiresAt < new Date()) {
            // এক্সপায়ার্ড
            delete approved[deviceId];
            fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
            console.log(`⏰ Expired: ${deviceId}`);
            res.json({ status: 'expired' });
        } else {
            console.log(`✅ Approved: ${deviceId}`);
            res.json({ status: 'approved', expiresAt: userApproved.expiresAt });
        }
    } else if (pendingRequest) {
        console.log(`⏳ Pending: ${deviceId}`);
        res.json({ status: 'pending' });
    } else {
        console.log(`❌ No access: ${deviceId}`);
        res.json({ status: 'none' });
    }
});

// 4. প্রোফাইল পাওয়া
app.post('/api/get-device-profiles', (req, res) => {
    const { deviceId } = req.body;
    const devices = JSON.parse(fs.readFileSync(DEVICES_FILE));
    
    if (devices[deviceId]) {
        res.json({ success: true, profiles: devices[deviceId].profiles || [] });
    } else {
        res.json({ success: false, profiles: [] });
    }
});

// 5. লঞ্চ রিকোয়েস্ট
app.post('/api/launch-request', (req, res) => {
    const { deviceId, numbers } = req.body;
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
    
    if (!approved[deviceId].pendingCommands) approved[deviceId].pendingCommands = [];
    approved[deviceId].pendingCommands.push({ type: 'launch', numbers, timestamp: Date.now() });
    fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
    
    console.log(`🚀 Launch command to: ${deviceId} for profiles: ${numbers.join(',')}`);
    res.json({ success: true, message: `Launching ${numbers.length} profiles!` });
});

// 6. কমান্ড পাওয়া (ক্লায়েন্টের জন্য)
app.post('/api/get-commands', (req, res) => {
    const { deviceId } = req.body;
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    
    if (!approved[deviceId]) {
        return res.json({ success: false, message: 'Not approved!' });
    }
    
    const pendingCommands = approved[deviceId].pendingCommands || [];
    approved[deviceId].pendingCommands = [];
    fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
    
    console.log(`📡 Commands sent to: ${deviceId} (${pendingCommands.length} commands)`);
    res.json({ success: true, commands: pendingCommands });
});

// ==================== অ্যাডমিন APIs ====================

// সব রিকোয়েস্ট দেখা
app.get('/api/admin/requests', (req, res) => {
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    console.log(`📋 Admin viewed requests: ${requests.length} total`);
    res.json(requests);
});

// অ্যাপ্রুভ করা
app.post('/api/admin/approve', (req, res) => {
    const { deviceId, hours, userName } = req.body;
    console.log(`📝 Approve request for: ${deviceId}, hours: ${hours}`);
    
    // 1. রিকোয়েস্ট আপডেট
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    const requestIndex = requests.findIndex(r => r.deviceId === deviceId);
    
    if (requestIndex !== -1) {
        requests[requestIndex].status = 'approved';
        requests[requestIndex].approvedAt = new Date().toISOString();
        fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
        console.log(`   ✅ Request updated in requests.json`);
    } else {
        console.log(`   ⚠️ Request not found in requests.json`);
    }
    
    // 2. অ্যাপ্রুভড লিস্টে যোগ
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + parseInt(hours));
    
    approved[deviceId] = {
        deviceId: deviceId,
        userName: userName || 'Unknown',
        approvedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        hours: parseInt(hours),
        pendingCommands: []
    };
    
    fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
    console.log(`   ✅ Added to approved.json, expires: ${expiresAt.toISOString()}`);
    
    // 3. Socket.io নোটিফিকেশন
    io.emit('request-approved', { deviceId });
    
    console.log(`🎉 APPROVED: ${deviceId} for ${hours} hours`);
    res.json({ success: true });
});

// রিজেক্ট করা
app.post('/api/admin/reject', (req, res) => {
    const { deviceId } = req.body;
    console.log(`📝 Reject request for: ${deviceId}`);
    
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    const filteredRequests = requests.filter(r => r.deviceId !== deviceId);
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify(filteredRequests, null, 2));
    
    io.emit('request-rejected', { deviceId });
    
    console.log(`❌ REJECTED: ${deviceId}`);
    res.json({ success: true });
});

// ডিবাগ এন্ডপয়েন্ট - সব ডাটা দেখা
app.get('/api/admin/debug', (req, res) => {
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    const devices = JSON.parse(fs.readFileSync(DEVICES_FILE));
    
    res.json({
        requests: requests,
        approved: approved,
        devices: devices
    });
});

// ==================== HTML রুটস ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n╔════════════════════════════════════════════════╗`);
    console.log(`║     🚀 Chrome Launcher Server Running        ║`);
    console.log(`╚════════════════════════════════════════════════╝`);
    console.log(`\n   📍 Port: ${PORT}`);
    console.log(`   🌐 URL: http://localhost:${PORT}`);
    console.log(`   👑 Admin: http://localhost:${PORT}/admin.html`);
    console.log(`   🔍 Debug: http://localhost:${PORT}/api/admin/debug`);
    console.log(`\n   ✅ Ready to accept requests!\n`);
});
