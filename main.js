const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Store active game sessions
const gameSessions = new Map();

// Color codes for better console output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

// PostgreSQL connection
// PostgreSQL connection for Render
const pool = new Pool({
    user: process.env.DB_USER || 'horse_racing_user',
    host: process.env.DB_HOST || 'dpg-d6tam96uk2gs738n6p0g-a',
    database: process.env.DB_NAME || 'horse_racing',
    password: process.env.DB_PASSWORD || 'N13aDz5NfsJLcmkzVrlmkG9G7254nS6z',
    port: process.env.DB_PORT || 5432,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
console.log(`${colors.cyan}🔌 Attempting to connect to PostgreSQL...${colors.reset}`);

pool.connect((err, client, release) => {
    if (err) {
        console.log(`${colors.red}❌ DATABASE CONNECTION FAILED!${colors.reset}`);
        console.log(`${colors.red}Error details:${colors.reset}`, err.message);
    } else {
        console.log(`${colors.green}✅ DATABASE CONNECTED SUCCESSFULLY!${colors.reset}`);
        release();
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Socket.io connection
io.on('connection', (socket) => {
    console.log(`${colors.green}🔌 New client connected - Socket ID: ${socket.id}${colors.reset}`);
    
    socket.on('request-timer', () => {
        const now = Date.now();
        const nextRaceTime = Math.ceil(now / 6000) * 6000;
        const currentGameId = `GAME-${Math.floor(nextRaceTime / 1000).toString().slice(-6)}`;
        
        socket.emit('race-timer', {
            nextRaceTime: nextRaceTime,
            gameId: currentGameId
        });
        
        const timerInterval = setInterval(() => {
            const now = Date.now();
            const timeToNext = nextRaceTime - now;
            
            if (timeToNext <= 5000 && timeToNext > 0) {
                socket.emit('race-starting-soon', { gameId: currentGameId });
            }
            
            if (timeToNext <= 0) {
                clearInterval(timerInterval);
                socket.emit('race-started', { gameId: currentGameId });
                
                const game = gameSessions.get(currentGameId);
                if (game && game.status === 'waiting') {
                    startRace(currentGameId);
                }
            }
        }, 1000);
        
        socket.on('disconnect', () => {
            clearInterval(timerInterval);
        });
    });
    
    socket.on('join-game', (data) => {
        const { gameId, phone, horseNumber, betAmount } = data;
        socket.join(`game-${gameId}`);
        
        console.log(`${colors.cyan}👤 Player ${phone} joining game ${gameId} - Horse ${horseNumber}${colors.reset}`);
        
        if (!gameSessions.has(gameId)) {
            gameSessions.set(gameId, {
                id: gameId,
                players: [],
                startTime: null,
                status: 'waiting',
                winningHorse: null
            });
            console.log(`${colors.green}✅ New game session created: ${gameId}${colors.reset}`);
        }
        
        const game = gameSessions.get(gameId);
        
        const existingPlayer = game.players.find(p => p.phone === phone);
        if (!existingPlayer) {
            game.players.push({
                socketId: socket.id,
                phone,
                horseNumber: parseInt(horseNumber),
                betAmount: parseFloat(betAmount)
            });
        }
        
        console.log(`${colors.yellow}👥 Game ${gameId} now has ${game.players.length} players${colors.reset}`);
        
        io.to(`game-${gameId}`).emit('player-count-update', {
            count: game.players.length
        });
    });
    
    socket.on('start-race', (gameId) => {
        startRace(gameId);
    });
    
    socket.on('disconnect', () => {
        console.log(`${colors.yellow}🔌 Client disconnected - Socket ID: ${socket.id}${colors.reset}`);
        
        gameSessions.forEach((game, gameId) => {
            const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
            if (playerIndex !== -1) {
                const player = game.players[playerIndex];
                console.log(`${colors.yellow}👤 Player ${player.phone} removed from game ${gameId}${colors.reset}`);
                game.players.splice(playerIndex, 1);
                
                io.to(`game-${gameId}`).emit('player-count-update', {
                    count: game.players.length
                });
            }
        });
    });
});

function startRace(gameId) {
    const game = gameSessions.get(gameId);
    if (!game) {
        console.log(`${colors.red}❌ Game ${gameId} not found${colors.reset}`);
        return;
    }
    
    if (game.status === 'waiting') {
        game.status = 'racing';
        game.startTime = Date.now();
        
        const winningHorse = 1;
        game.winningHorse = winningHorse;
        
        console.log(`${colors.magenta}🏁 Race ${gameId} STARTED! Winning horse: ${winningHorse}${colors.reset}`);
        console.log(`${colors.yellow}👥 Players in race: ${game.players.length}${colors.reset}`);
        
        io.to(`game-${gameId}`).emit('race-started', {
            winningHorse: winningHorse,
            startTime: game.startTime
        });
        
        setTimeout(() => {
            finishRace(gameId);
        }, 8000);
    }
}

async function finishRace(gameId) {
    const game = gameSessions.get(gameId);
    if (!game || game.status !== 'racing') return;
    
    game.status = 'finished';
    
    console.log(`${colors.magenta}🏁 Race ${gameId} FINISHED! Winner: Horse ${game.winningHorse}${colors.reset}`);
    
    const results = game.players.map(player => {
        const won = player.horseNumber === game.winningHorse;
        const winAmount = won ? player.betAmount * 4.5 : 0;
        
        return {
            phone: player.phone,
            horseNumber: player.horseNumber,
            won: won,
            winAmount: winAmount
        };
    });
    
    for (const result of results) {
        if (result.won) {
            try {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    
                    await client.query(
                        'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone = $2',
                        [result.winAmount, result.phone]
                    );
                    
                    const updatedUser = await client.query(
                        'SELECT wallet_balance FROM users WHERE phone = $1',
                        [result.phone]
                    );
                    
                    await client.query('COMMIT');
                    
                    const newBalance = parseFloat(updatedUser.rows[0].wallet_balance);
                    console.log(`${colors.green}💰 Player ${result.phone} won $${result.winAmount.toFixed(2)} - New balance: $${newBalance.toFixed(2)}${colors.reset}`);
                    
                    const playerSocket = game.players.find(p => p.phone === result.phone)?.socketId;
                    if (playerSocket) {
                        io.to(playerSocket).emit('balance-update', {
                            newBalance: newBalance
                        });
                    }
                    
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }
            } catch (error) {
                console.error(`${colors.red}❌ Error updating balance for ${result.phone}:${colors.reset}`, error.message);
            }
        }
    }
    
    io.to(`game-${gameId}`).emit('race-finished', {
        gameId: gameId,
        winningHorse: game.winningHorse,
        results: results
    });
    
    setTimeout(() => {
        gameSessions.delete(gameId);
        console.log(`${colors.yellow}🧹 Game ${gameId} cleaned up${colors.reset}`);
    }, 30000);
}

app.post('/login', async (req, res) => {
    const { phone, password } = req.body;
    const timestamp = new Date().toISOString();
    
    console.log(`${colors.cyan}📝 [${timestamp}] Login attempt for phone: ${phone}${colors.reset}`);
    
    if (!phone || phone.trim() === '' || !password || password.trim() === '') {
        console.log(`${colors.red}❌ Login failed: Missing credentials${colors.reset}`);
        return res.status(400).json({ 
            success: false, 
            error: 'Phone number and password are required' 
        });
    }

    try {
        const userResult = await pool.query(
            'SELECT * FROM users WHERE phone = $1', 
            [phone.trim()]
        );
        
        if (userResult.rows.length === 0) {
            console.log(`${colors.red}❌ Login failed: User not found - ${phone}${colors.reset}`);
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid phone number or password' 
            });
        }
        
        const user = userResult.rows[0];
        
        if (user.password !== password) {
            console.log(`${colors.red}❌ Login failed: Invalid password for ${phone}${colors.reset}`);
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid phone number or password' 
            });
        }
        
        console.log(`${colors.green}✅ USER LOGGED IN:${colors.reset}`);
        console.log(`  • Phone: ${user.phone}`);
        console.log(`  • Balance: $${parseFloat(user.wallet_balance).toFixed(2)}`);
        
        res.json({ 
            success: true, 
            user: {
                id: user.id,
                phone: user.phone,
                wallet_balance: parseFloat(user.wallet_balance)
            }
        });
        
    } catch (error) {
        console.log(`${colors.red}❌ Login error:${colors.reset}`, error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Server error during login' 
        });
    }
});

app.post('/validate-telegram-token', async (req, res) => {
    const { token } = req.body;
    
    try {
        const decoded = Buffer.from(token, 'base64').toString('ascii');
        const [phone, userId, timestamp, random] = decoded.split(':');
        
        const now = Date.now();
        if (now - parseInt(timestamp) > 300000) {
            return res.json({ success: false, error: 'Token expired' });
        }
        
        const user = await pool.query(
            'SELECT * FROM users WHERE phone = $1 AND id = $2',
            [phone, userId]
        );
        
        if (user.rows.length === 0) {
            return res.json({ success: false, error: 'Invalid token' });
        }
        
        res.json({ 
            success: true, 
            user: {
                id: user.rows[0].id,
                phone: user.rows[0].phone,
                wallet_balance: parseFloat(user.rows[0].wallet_balance)
            }
        });
        
    } catch (error) {
        console.error('Token validation error:', error);
        res.json({ success: false, error: 'Invalid token' });
    }
});

app.get('/wallet/:phone', async (req, res) => {
    const { phone } = req.params;
    
    try {
        const user = await pool.query(
            'SELECT wallet_balance FROM users WHERE phone = $1', 
            [phone]
        );
        
        if (user.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ balance: parseFloat(user.rows[0].wallet_balance) });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/bet', async (req, res) => {
    const { phone, horseNumber, betAmount } = req.body;
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const userResult = await client.query(
            'SELECT * FROM users WHERE phone = $1 FOR UPDATE', 
            [phone]
        );
        
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        const currentBalance = parseFloat(user.wallet_balance);
        
        if (currentBalance < betAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        await client.query(
            'UPDATE users SET wallet_balance = wallet_balance - $1 WHERE phone = $2',
            [betAmount, phone]
        );
        
        const betResult = await client.query(
            'INSERT INTO bets (user_id, horse_number, bet_amount) VALUES ($1, $2, $3) RETURNING id',
            [user.id, horseNumber, betAmount]
        );
        
        await client.query('COMMIT');
        
        const gameId = `GAME-${Math.floor(Date.now() / 60000).toString().slice(-6)}`;
        
        console.log(`${colors.green}✅ Bet placed for ${phone} - Game ID: ${gameId}${colors.reset}`);
        
        res.json({ 
            success: true, 
            betId: betResult.rows[0].id,
            newBalance: currentBalance - betAmount,
            gameId: gameId
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`${colors.red}❌ Bet error:${colors.reset}`, error.message);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// Get referral statistics
async function getReferralStats(phone) {
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_referrals,
                COALESCE(SUM(bonus_amount), 0) as total_bonus
            FROM referrals 
            WHERE referrer_phone = $1 AND bonus_awarded = TRUE
        `, [phone]);
        
        return result.rows[0];
    } catch (err) {
        console.error('Error getting referral stats:', err);
        return { total_referrals: 0, total_bonus: 0 };
    }
}

// Get user referrals
app.get('/user/referrals/:phone', async (req, res) => {
    const { phone } = req.params;
    
    try {
        const stats = await getReferralStats(phone);
        
        const referrals = await pool.query(`
            SELECT referred_phone, created_at, bonus_amount, bonus_awarded, bonus_awarded_at 
            FROM referrals 
            WHERE referrer_phone = $1 
            ORDER BY created_at DESC
        `, [phone]);
        
        res.json({ 
            success: true,
            total_referrals: stats.total_referrals,
            total_bonus: stats.total_bonus,
            referrals: referrals.rows
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin routes
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === 'admin' && password === 'admin123') {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.get('/admin/bets', async (req, res) => {
    try {
        const bets = await pool.query(`
            SELECT horse_number, COALESCE(SUM(bet_amount), 0) as total_bet
            FROM bets 
            WHERE created_at >= CURRENT_DATE
            GROUP BY horse_number
            ORDER BY horse_number
        `);
        
        const result = Array(6).fill(0).map((_, i) => {
            const horseBet = bets.rows.find(r => r.horse_number === i + 1);
            return {
                horse: i + 1,
                total: horseBet ? parseFloat(horseBet.total_bet) : 0
            };
        });
        
        res.json(result);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/admin/members', async (req, res) => {
    try {
        const members = await pool.query(
            'SELECT phone, wallet_balance, created_at, total_deposits, total_referrals, referral_bonus FROM users ORDER BY id'
        );
        
        res.json(members.rows.map(m => ({
            ...m,
            wallet_balance: parseFloat(m.wallet_balance),
            total_deposits: parseFloat(m.total_deposits),
            referral_bonus: parseFloat(m.referral_bonus)
        })));
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Admin add balance - WITH REFERRAL BONUS ON ANY DEPOSIT
app.post('/admin/add-balance', async (req, res) => {
    const { phone, amount } = req.body;
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Update user balance and total deposits
        const result = await client.query(
            'UPDATE users SET wallet_balance = wallet_balance + $1, total_deposits = total_deposits + $2 WHERE phone = $3 RETURNING *',
            [amount, amount, phone]
        );
        
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        
        const updatedUser = result.rows[0];
        
        // Check for pending referral bonus (ANY deposit, not just first)
        console.log(`💰 Deposit detected for ${phone}, checking for pending referrals...`);
        
        const referralCheck = await client.query(
            'SELECT * FROM referrals WHERE referred_phone = $1 AND bonus_awarded = FALSE',
            [phone]
        );
        
        console.log(`🔍 Found ${referralCheck.rows.length} pending referrals`);
        
        if (referralCheck.rows.length > 0) {
            const referral = referralCheck.rows[0];
            const bonusAmount = 10.00;
            
            console.log(`🎁 Awarding referral bonus: ${referral.referrer_phone} gets $10 for referring ${phone}`);
            
            // Award bonus to referrer
            await client.query(
                'UPDATE users SET wallet_balance = wallet_balance + $1, referral_bonus = referral_bonus + $1, total_referrals = total_referrals + 1 WHERE phone = $2',
                [bonusAmount, referral.referrer_phone]
            );
            
            // Mark bonus as awarded
            await client.query(
                'UPDATE referrals SET bonus_awarded = TRUE, bonus_awarded_at = NOW() WHERE id = $1',
                [referral.id]
            );
            
            console.log(`✅ Referral bonus awarded: ${referral.referrer_phone} got $${bonusAmount} from ${phone}'s deposit!`);
        }
        
        await client.query('COMMIT');
        
        res.json({ 
            success: true,
            user: {
                phone: updatedUser.phone,
                wallet_balance: parseFloat(updatedUser.wallet_balance),
                total_deposits: parseFloat(updatedUser.total_deposits)
            }
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Add balance error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});
app.get('/admin/withdrawals', async (req, res) => {
    try {
        const withdrawals = await pool.query(`
            SELECT w.id, u.phone, w.amount, w.status, w.created_at
            FROM withdrawals w
            JOIN users u ON w.user_id = u.id
            WHERE w.status = 'pending'
            ORDER BY w.created_at DESC
        `);
        
        res.json(withdrawals.rows.map(w => ({
            ...w,
            amount: parseFloat(w.amount)
        })));
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/admin/approve-withdraw', async (req, res) => {
    const { id, action } = req.body;
    
    try {
        await pool.query(
            'UPDATE withdrawals SET status = $1 WHERE id = $2',
            [action === 'approve' ? 'paid' : 'rejected', id]
        );
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test route
app.get('/test', (req, res) => {
    res.json({ 
        message: 'Server is running!',
        activeGames: gameSessions.size
    });
});
// Get user info (for registration time)
app.get('/user/info/:phone', async (req, res) => {
    const { phone } = req.params;
    
    try {
        const user = await pool.query(
            'SELECT created_at, wallet_balance, total_referrals FROM users WHERE phone = $1',
            [phone]
        );
        
        if (user.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        res.json({
            success: true,
            created_at: user.rows[0].created_at,
            wallet_balance: parseFloat(user.rows[0].wallet_balance),
            total_referrals: user.rows[0].total_referrals
        });
        
    } catch (error) {
        console.error('Error getting user info:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// Admin delete member
app.post('/admin/delete-member', async (req, res) => {
    const { phone } = req.body;
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Check if user exists
        const userCheck = await client.query(
            'SELECT id FROM users WHERE phone = $1',
            [phone]
        );
        
        if (userCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Delete user (cascade will handle related records)
        await client.query(
            'DELETE FROM users WHERE phone = $1',
            [phone]
        );
        
        await client.query('COMMIT');
        
        console.log(`${colors.red}🗑️ Member deleted: ${phone}${colors.reset}`);
        
        res.json({ success: true });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete member error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.green}🚀 SERVER STARTED SUCCESSFULLY!${colors.reset}`);
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.cyan}📡 Server URL: http://localhost:${PORT}${colors.reset}`);
    console.log(`${colors.cyan}👤 User login: http://localhost:${PORT}/login.html${colors.reset}`);
    console.log(`${colors.cyan}👑 Admin login: http://localhost:${PORT}/admin-login.html${colors.reset}`);
    console.log(`${colors.green}═══════════════════════════════════════════════${colors.reset}`);
});