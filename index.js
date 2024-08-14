const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const playersData = require('./players.js');


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
    },
});

app.use(cors());
app.use(express.json());

mongoose.connect('mongodb://localhost:27017/auction', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

const UserSchema = new mongoose.Schema({
    username: String,
    balance: Number,
});

const AuctionSchema = new mongoose.Schema({
    name: String,
    currentBid: Number,
    highestBidder: String,
    endsAt: Date,
    isLive: { type: Boolean, default: false },
    isSpotlighted: { type: Boolean, default: false },  // New field to spotlight auction
    estimates: [Number],
    averageEstimate: { type: Number, default: 0 },
    estimateDeadline: Date,
    sold: { type: Boolean, default: false },
});

const User = mongoose.model('User', UserSchema);
const Auction = mongoose.model('Auction', AuctionSchema);


app.get('/api/auctions', async (req, res) => {
    const auctions = await Auction.find();

    auctions.sort((a, b) => {
        if (a.isSpotlighted && !b.isSpotlighted) {
            return -1;
        } else if (!a.isSpotlighted && b.isSpotlighted) {
            return 1;
        } else
            if (a.sold && !b.sold) {
                return 1;
            } else if (!a.sold && b.sold) {
                return -1;
            } else {
                return a.name.localeCompare(b.name);
            }
    })

    res.json(auctions);
});

app.post('/api/auctions', async (req, res) => {
    const { name } = req.body;

    // Create a new auction item
    const auction = new Auction({
        name,
        currentBid: 0,
        highestBidder: null, // Initially, no bidder
    });

    console.log("New auction item added", auction);

    try {
        const savedAuction = await auction.save();
        res.status(201).json(savedAuction);
    } catch (err) {
        res.status(500).json({ message: 'Failed to create auction item', error: err });
    }
});

app.post('/api/submit-estimate', async (req, res) => {
    const { auctionId, estimate } = req.body;

    try {
        const auction = await Auction.findById(auctionId);

        // Add the new estimate
        auction.estimates.push(estimate);

        // Recalculate the average estimate
        const totalEstimates = auction.estimates.reduce((sum, est) => sum + est, 0);
        auction.averageEstimate = totalEstimates / auction.estimates.length;

        // Save the auction with the updated estimates and average
        await auction.save();

        io.emit('estimateUpdated', auction);  // Notify all clients of the updated estimate
        console.log(`New estimate submitted, ${auctionId}, ${estimate}`)
        res.status(201).json(auction);
    } catch (err) {
        res.status(500).json({ message: 'Failed to submit estimate', error: err });
    }
});

app.post('/api/spotlight-auction', async (req, res) => {
    const { auctionId } = req.body;

    try {
        // Set all auctions to not spotlighted
        await Auction.updateMany({}, { isSpotlighted: false });

        // Set the selected auction as spotlighted
        const auction = await Auction.findByIdAndUpdate(auctionId, {
            isSpotlighted: true,
        }, { new: true });

        io.emit('auctionSpotlighted', auction); // Notify clients of the spotlighted auction
        res.json(auction);
    } catch (err) {
        res.status(500).json({ message: 'Failed to spotlight auction', error: err });
    }
});

app.post('/api/start-auction', async (req, res) => {
    const { auctionId } = req.body;

    try {
        const estimateDeadline = new Date(Date.now() + 30 * 1000); // 30 seconds from now
        const auction = await Auction.findByIdAndUpdate(auctionId, {
            isLive: true,
            estimateDeadline,
        }, { new: true });

        io.emit('auctionStarted', auction); // Notify clients that the auction has started
        res.json(auction);
    } catch (err) {
        res.status(500).json({ message: 'Failed to start auction', error: err });
    }
});

app.get('/api/live-auction', async (req, res) => {
    const auction = await Auction.findOne({ isLive: true });
    res.json(auction);
});

app.get('/api/spotlight-auction', async (req, res) => {
    const auction = await Auction.findOne({ isSpotlighted: true });
    res.json(auction);
})

app.get('/api/teams', async (req, res) => {
    const teams = {
        team1: [],
        team2: [],
        unassigned: [],
    }

    const players = await Auction.find();

    players.forEach(player => {
        player = player.toObject();
        const playerData = playersData.players.find(p => p.name === player.name);
        player.tagline = playerData.tagline;
        player.image = playerData.image;
        player.description = playerData.description;

        console.log(player)

        if (player.sold && player.highestBidder === 'Liam') {
            teams.team1.push(player);
        } else if (player.sold && player.highestBidder === 'Potto') {
            teams.team2.push(player);
        } else {
            teams.unassigned.push(player);
        }
    })

    res.json(teams);
})

app.post('/api/mark-as-sold', async (req, res) => {
    const { auctionId } = req.body;

    try {
        const auction = await Auction.findById(auctionId);
        if (!auction) {
            return res.status(404).json({ message: 'Auction not found' });
        }

        if (auction.sold) {
            return res.status(400).json({ message: 'Auction is already sold' });
        }

        auction.sold = true;
        await auction.save();

        io.emit('auctionSold', auction);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: 'Failed to mark auction as sold', error: err });
    }
});

app.post('/api/bid', async (req, res) => {
    const { auctionId, userId, bidAmount } = req.body;
    const auction = await Auction.findById(auctionId);

    if (!auction) {
        return res.status(404).json({ message: 'Auction not found' });
    }

    if (auction.sold) {
        return res.status(400).json({ message: 'Cannot bid on a sold item' });
    }

    if (bidAmount <= auction.currentBid) {
        return res.status(400).json({ message: 'Bid must be higher than the current bid' });
    }

    auction.currentBid = bidAmount;
    auction.highestBidder = userId;
    await auction.save();

    io.emit('newBid', auction);
    res.json({ success: true });
});

app.post('/api/reset-auction', async (req, res) => {
    const { auctionId } = req.body;

    try {
        const auction = await Auction.findById(auctionId);
        if (!auction) {
            return res.status(404).json({ message: 'Auction not found' });
        }

        auction.currentBid = 0;
        auction.estimates = [];
        auction.highestBidder = null;
        auction.averageEstimate = null;
        auction.sold = false;
        auction.estimateDeadline = null;
        auction.isSpotlighted = false;
        auction.isLive = false;

        await auction.save();

        io.emit('auctionReset', { auctionId });
        res.json({ success: true, auction });
    } catch (err) {
        res.status(500).json({ message: 'Failed to reset auction', error: err });
    }
});


io.on('connection', (socket) => {
    console.log('a user connected');
    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

server.listen(3000, () => {
    console.log('Server is running on port 3000');
});

