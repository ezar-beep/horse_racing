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
const gameSessions = new Map(); // gameId -> { players: [], startTime: , winningHorse: , status: }

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
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'horse_racing',
    password: 'mahtot123',
    port: 5432,
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
    
    // Handle timer requests
    socket.on('request-timer', () => {
        // Calculate next race start (every 60 seconds, aligned to clock)
        const now = Date.now();
        const nextRaceTime = Math.ceil(now / 60000) * 60000; // Next minute mark
        const currentGameId = `GAME-${Math.floor(nextRaceTime / 1000).toString().slice(-6)}`;
        
        socket.emit('race-timer', {
            nextRaceTime: nextRaceTime,
            gameId: currentGameId
        });
        
        // Set up interval for this client
        const timerInterval = setInterval(() => {
            const now = Date.now();
            const timeToNext = nextRaceTime - now;
            
            if (timeToNext <= 5000 && timeToNext > 0) {
                socket.emit('race-starting-soon', { gameId: currentGameId });
            }
            
            if (timeToNext <= 0) {
                clearInterval(timerInterval);
                socket.emit('race-started', { gameId: currentGameId });
                
                // Automatically start the race for this game
                const game = gameSessions.get(currentGameId);
                if (game && game.status === 'waiting') {
                    startRace(currentGameId);
                }
            }
        }, 1000);
        
        // Clean up on disconnect
        socket.on('disconnect', () => {
            clearInterval(timerInterval);
        });
    });
    
    // Join a game room
    socket.on('join-game', (data) => {
        const { gameId, phone, horseNumber, betAmount } = data;
        socket.join(`game-${gameId}`);
        
        console.log(`${colors.cyan}👤 Player ${phone} joining game ${gameId} - Horse ${horseNumber}${colors.reset}`);
        
        // Create or update game session
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
        
        // Check if player already exists
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
        
        // Send current player count to all in the game
        io.to(`game-${gameId}`).emit('player-count-update', {
            count: game.players.length
        });
    });
    
    // Manual start race (can be triggered by first player)
    socket.on('start-race', (gameId) => {
        startRace(gameId);
    });
    
    socket.on('disconnect', () => {
        console.log(`${colors.yellow}🔌 Client disconnected - Socket ID: ${socket.id}${colors.reset}`);
        
        // Remove player from any games
        gameSessions.forEach((game, gameId) => {
            const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
            if (playerIndex !== -1) {
                const player = game.players[playerIndex];
                console.log(`${colors.yellow}👤 Player ${player.phone} removed from game ${gameId}${colors.reset}`);
                game.players.splice(playerIndex, 1);
                
                // Update player count
                io.to(`game-${gameId}`).emit('player-count-update', {
                    count: game.players.length
                });
            }
        });
    });
});

// Function to start a race
function startRace(gameId) {
    const game = gameSessions.get(gameId);
    if (!game) {
        console.log(`${colors.red}❌ Game ${gameId} not found${colors.reset}`);
        return;
    }
    
    if (game.status === 'waiting') {
        game.status = 'racing';
        game.startTime = Date.now();
        
        // Generate random winning horse ONCE on server
        const winningHorse = Math.floor(Math.random() * 6) + 1;
        game.winningHorse = winningHorse;
        
        console.log(`${colors.magenta}🏁 Race ${gameId} STARTED! Winning horse: ${winningHorse}${colors.reset}`);
        console.log(`${colors.yellow}👥 Players in race: ${game.players.length}${colors.reset}`);
        
        // Send race start event to all players with the SAME winning horse
        io.to(`game-${gameId}`).emit('race-started', {
            winningHorse: winningHorse,
            startTime: game.startTime
        });
        
        // Race duration: 8 seconds
        setTimeout(() => {
            finishRace(gameId);
        }, 8000);
    }
}

// Function to finish a race// Function to finish a race
async function finishRace(gameId) {
    const game = gameSessions.get(gameId);
    if (!game || game.status !== 'racing') return;
    
    game.status = 'finished';
    
    console.log(`${colors.magenta}🏁 Race ${gameId} FINISHED! Winner: Horse ${game.winningHorse}${colors.reset}`);
    
    // Calculate results for each player
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
    
    // Update winners' balances in database
    for (const result of results) {
        if (result.won) {
            try {
                // Use a transaction to ensure consistency
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    
                    // Update user balance
                    await client.query(
                        'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone = $2',
                        [result.winAmount, result.phone]
                    );
                    
                    // Get updated balance
                    const updatedUser = await client.query(
                        'SELECT wallet_balance FROM users WHERE phone = $1',
                        [result.phone]
                    );
                    
                    await client.query('COMMIT');
                    
                    const newBalance = parseFloat(updatedUser.rows[0].wallet_balance);
                    console.log(`${colors.green}💰 Player ${result.phone} won $${result.winAmount.toFixed(2)} - New balance: $${newBalance.toFixed(2)}${colors.reset}`);
                    
                    // Emit balance update to the specific player
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
    
    // Send results to all players with the SAME winning horse
    io.to(`game-${gameId}`).emit('race-finished', {
        gameId: gameId,
        winningHorse: game.winningHorse,
        results: results
    });
    
    // Clean up after 30 seconds
    setTimeout(() => {
        gameSessions.delete(gameId);
        console.log(`${colors.yellow}🧹 Game ${gameId} cleaned up${colors.reset}`);
    }, 30000);
}
// Login route
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

// Get wallet balance
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

// Place bet
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
        
        // Generate game ID (60-second windows)
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

// Withdrawal request
app.post('/withdraw', async (req, res) => {
    const { phone, amount } = req.body;
    
    try {
        const userResult = await pool.query(
            'SELECT id FROM users WHERE phone = $1', 
            [phone]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        await pool.query(
            'INSERT INTO withdrawals (user_id, amount) VALUES ($1, $2)',
            [userResult.rows[0].id, amount]
        );
        
        res.json({ success: true });
        
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
            'SELECT phone, wallet_balance FROM users ORDER BY id'
        );
        
        res.json(members.rows.map(m => ({
            ...m,
            wallet_balance: parseFloat(m.wallet_balance)
        })));
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/admin/add-balance', async (req, res) => {
    const { phone, amount } = req.body;
    
    try {
        const result = await pool.query(
            'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone = $2 RETURNING wallet_balance',
            [amount, phone]
        );
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/admin/withdrawals', async (req, res) => {
    try {
        const withdrawals = await pool.query(`
            SELECT w.id, u.phone, w.amount, w.status 
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