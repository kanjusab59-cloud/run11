const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ডাটা ফোল্ডার এবং ফাইল তৈরি
const DATA_DIR = path.join(__dirname, 'data');
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');
const APPROVED_FILE = path.join(DATA_DIR, 'approved.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(REQUESTS_FILE)) fs.writeFileSync(REQUESTS_FILE, JSON.stringify([]));
if (!fs.existsSync(APPROVED_FILE)) fs.writeFileSync(APPROVED_FILE, JSON.stringify({}));

// Chrome পাথ বের করার ফাংশন
function getChromePath() {
    const possiblePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env.USERPROFILE + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    ];
    
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) return p;
    }
    
    try {
        const { execSync } = require('child_process');
        const result = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve', { encoding: 'utf8' });
        const match = result.match(/REG_SZ\s+(.+)/);
        if (match && match[1]) return match[1].trim();
    } catch(e) {}
    
    return null;
}

// সব Chrome প্রোফাইল বের করার ফাংশন
function getAllProfiles() {
    const profilesDir = path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\User Data');
    
    if (!fs.existsSync(profilesDir)) return [];
    
    const folders = fs.readdirSync(profilesDir);
    const profiles = [];
    
    for (const folder of folders) {
        const prefFile = path.join(profilesDir, folder, 'Preferences');
        if (fs.existsSync(prefFile)) {
            let name = folder;
            let hasPicture = false;
            
            try {
                const data = fs.readFileSync(prefFile, 'utf8');
                const nameMatch = data.match(/"name":"([^"]+)"/);
                if (nameMatch && nameMatch[1]) name = nameMatch[1];
            } catch(e) {}
            
            if (folder === 'Default') name = 'Default';
            
            const picPaths = [
                path.join(profilesDir, folder, 'Google Profile Picture.png'),
                path.join(profilesDir, folder, 'Profile Picture.png')
            ];
            
            for (const picPath of picPaths) {
                if (fs.existsSync(picPath)) {
                    hasPicture = true;
                    break;
                }
            }
            
            profiles.push({
                name: name,
                folder: folder,
                hasPicture: hasPicture
            });
        }
    }
    
    return profiles;
}

// প্রোফাইল লঞ্চ করার ফাংশন
function launchProfile(profileFolder, chromePath) {
    const url = 'https://www.facebook.com';
    const cmd = `start "" "${chromePath}" --profile-directory="${profileFolder}" "${url}"`;
    exec(cmd, (error) => {
        if (error) console.log(`Error: ${profileFolder}`);
        else console.log(`Launched: ${profileFolder}`);
    });
}

// API Routes

// ইউজারের রিকোয়েস্ট সেভ করা
app.post('/api/request-access', (req, res) => {
    const { userId, deviceName, profiles } = req.body;
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    
    // চেক করা ইতিমধ্যে request আছে কিনা
    const existing = requests.find(r => r.userId === userId);
    if (existing) {
        return res.json({ success: false, message: 'Request already pending!' });
    }
    
    requests.push({
        userId,
        deviceName,
        profiles,
        status: 'pending',
        timestamp: new Date().toISOString()
    });
    
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
    
    // Socket.io দিয়ে admin কে notify করা
    io.emit('new-request', { userId, deviceName });
    
    res.json({ success: true, message: 'Request sent to admin!' });
});

// ইউজারের স্ট্যাটাস চেক করা
app.post('/api/check-status', (req, res) => {
    const { userId } = req.body;
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    
    const userApproved = approved[userId];
    const pendingRequest = requests.find(r => r.userId === userId && r.status === 'pending');
    
    if (userApproved) {
        res.json({ status: 'approved', expiresAt: userApproved.expiresAt });
    } else if (pendingRequest) {
        res.json({ status: 'pending' });
    } else {
        res.json({ status: 'none' });
    }
});

// অ্যাডমিন: সব রিকোয়েস্ট দেখা
app.get('/api/admin/requests', (req, res) => {
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    res.json(requests);
});

// অ্যাডমিন: রিকোয়েস্ট approve করা
app.post('/api/admin/approve', (req, res) => {
    const { userId, hours } = req.body;
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    
    // রিকোয়েস্ট আপডেট করা
    const requestIndex = requests.findIndex(r => r.userId === userId);
    if (requestIndex !== -1) {
        requests[requestIndex].status = 'approved';
        fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
    }
    
    // Approved তে যোগ করা
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + parseInt(hours));
    
    approved[userId] = {
        approvedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        hours: hours
    };
    
    fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
    
    // ইউজারকে notify
    io.emit('request-approved', { userId });
    
    res.json({ success: true });
});

// অ্যাডমিন: রিকোয়েস্ট reject করা
app.post('/api/admin/reject', (req, res) => {
    const { userId } = req.body;
    const requests = JSON.parse(fs.readFileSync(REQUESTS_FILE));
    
    const requestIndex = requests.findIndex(r => r.userId === userId);
    if (requestIndex !== -1) {
        requests.splice(requestIndex, 1);
        fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
    }
    
    io.emit('request-rejected', { userId });
    
    res.json({ success: true });
});

// ইউজার: প্রোফাইল লঞ্চ করা (শুধু approved হলে)
app.post('/api/launch', (req, res) => {
    const { userId, numbers } = req.body;
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    
    // চেক করা approved কিনা
    if (!approved[userId]) {
        return res.json({ success: false, message: 'Not approved yet!' });
    }
    
    // চেক করা expire হয়নি কিনা
    const expiresAt = new Date(approved[userId].expiresAt);
    if (expiresAt < new Date()) {
        delete approved[userId];
        fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
        return res.json({ success: false, message: 'Access expired! Please request again.' });
    }
    
    const profiles = getAllProfiles();
    const chromePath = getChromePath();
    
    if (!chromePath) {
        return res.json({ success: false, message: 'Chrome not found!' });
    }
    
    let launched = 0;
    for (const num of numbers) {
        if (num >= 1 && num <= profiles.length) {
            launchProfile(profiles[num - 1].folder, chromePath);
            launched++;
        }
    }
    
    res.json({ success: true, message: `Launched ${launched} profiles!`, remainingTime: getRemainingTime(expiresAt) });
});

function getRemainingTime(expiresAt) {
    const diff = expiresAt - new Date();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
}

// ইউজার: প্রোফাইল লিস্ট পাওয়া (শুধু approved হলে)
app.post('/api/get-profiles', (req, res) => {
    const { userId } = req.body;
    const approved = JSON.parse(fs.readFileSync(APPROVED_FILE));
    
    if (!approved[userId]) {
        return res.json({ success: false, message: 'Not approved!' });
    }
    
    const expiresAt = new Date(approved[userId].expiresAt);
    if (expiresAt < new Date()) {
        delete approved[userId];
        fs.writeFileSync(APPROVED_FILE, JSON.stringify(approved, null, 2));
        return res.json({ success: false, message: 'Access expired!' });
    }
    
    const profiles = getAllProfiles();
    res.json({ success: true, profiles, remainingTime: getRemainingTime(expiresAt) });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║     🚀 Chrome Profile Launcher Server Running          ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`   📍 User URL: http://localhost:${PORT}`);
    console.log(`   👑 Admin URL: http://localhost:${PORT}/admin.html`);
    console.log('');
    console.log('   ✅ Server started successfully!');
    console.log('');
});