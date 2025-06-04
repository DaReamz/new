// Import required packages
const { Client } = require("guilded.js");
const axios = require("axios");
require("dotenv").config();
const fs = require('fs');

// --- Configuration ---
const guildedToken = process.env.GUILDED_TOKEN;
const shapesApiKey = process.env.SHAPES_API_KEY;
const shapeUsername = process.env.SHAPE_USERNAME;

const SHAPES_API_BASE_URL = "https://api.shapes.inc/v1";
const SHAPES_MODEL_NAME = `shapesinc/${shapeUsername}`;
const GUILDED_API_BASE_URL = "https://www.guilded.gg/api/v1";

// WHITELIST: Users that should ALWAYS be responded to (not considered bots)
const WHITELISTED_USERS = new Set([
    'Naftai777',
    'MysticalDreamz', 
    'XSuperNovaX2024'
]);

if (!guildedToken || !shapesApiKey || !shapeUsername) {
    console.error(
        "Error: Please ensure that GUILDED_TOKEN, SHAPES_API_KEY, and SHAPE_USERNAME are set in your .env file."
    );
    process.exit(1);
}

// Initialize Guilded Client with custom headers for official markdown support
const client = new Client({ 
    token: guildedToken,
    rest: {
        headers: {
            'x-guilded-bot-api-use-official-markdown': 'true'
        }
    },
    ws: {
        headers: {
            'x-guilded-bot-api-use-official-markdown': 'true'
        }
    }
});

// Override the REST client's request method to ensure header is always included
const originalRequest = client.rest.request;
client.rest.request = function(options) {
    if (!options.headers) {
        options.headers = {};
    }
    options.headers['x-guilded-bot-api-use-official-markdown'] = 'true';
    
    console.log(`[REST API] Adding official markdown header to ${options.method} ${options.path}`);
    return originalRequest.call(this, options);
};

// File path for storing active channels and known bots
const channelsFilePath = './active_channels.json';
const knownBotsFilePath = './known_bots.json';

// In-memory store for active channels (Channel IDs)
let activeChannels = new Set();

// In-memory store for known bots (User IDs that have been identified as bots)
let knownBots = new Set();

// Track recent messages to detect rapid-fire bot conversations
const recentMessages = new Map(); // channelId -> Array of {userId, timestamp}
const BOT_DETECTION_WINDOW = 30000; // 30 seconds
const MAX_MESSAGES_PER_USER = 5; // Max messages per user in the window

// Cache for signed URLs to avoid repeated requests
const signedUrlCache = new Map(); // url -> {signedUrl, expires}
const SIGNED_URL_CACHE_DURATION = 4 * 60 * 1000; // 4 minutes (before 5 minute expiry)

// --- Message Constants ---
const START_MESSAGE_ACTIVATE = () => `🤖 Hello! I am now active for **${shapeUsername}** in this channel. All messages here will be forwarded.`;
const START_MESSAGE_RESET = () => `🤖 The long-term memory for **${shapeUsername}** in this channel has been reset for you. You can start a new conversation.`;
const ALREADY_ACTIVE_MESSAGE = () => `🤖 I am already active in this channel for **${shapeUsername}**.`;
const NOT_ACTIVE_MESSAGE = () => `🤖 I am not active in this channel. Use \`/activate ${shapeUsername}\` first.`;
const DEACTIVATE_MESSAGE = () => `🤖 I am no longer active for **${shapeUsername}** in this channel.`;
const INCORRECT_ACTIVATE_MESSAGE = () => `🤖 To activate me, please use \`/activate ${shapeUsername}\`.`;

// --- Helper Functions ---

function loadActiveChannels() {
    try {
        if (fs.existsSync(channelsFilePath)) {
            const data = fs.readFileSync(channelsFilePath, 'utf8');
            const loadedChannelIds = JSON.parse(data);
            if (Array.isArray(loadedChannelIds)) {
                activeChannels = new Set(loadedChannelIds);
                console.log(`Active channels loaded: ${loadedChannelIds.join(', ')}`);
            } else {
                console.warn("Invalid format in active_channels.json. Starting with empty channels.");
                activeChannels = new Set();
            }
        } else {
            console.log("No active_channels.json found. Starting with empty channels.");
            activeChannels = new Set();
        }
    } catch (error) {
        console.error("Error loading active channels:", error);
        activeChannels = new Set();
    }
}

function saveActiveChannels() {
    try {
        const channelIdsArray = Array.from(activeChannels);
        fs.writeFileSync(channelsFilePath, JSON.stringify(channelIdsArray, null, 2));
        console.log(`Active channels saved: ${channelIdsArray.join(', ')}`);
    } catch (error) {
        console.error("Error saving active channels:", error);
    }
}

function loadKnownBots() {
    try {
        if (fs.existsSync(knownBotsFilePath)) {
            const data = fs.readFileSync(knownBotsFilePath, 'utf8');
            const loadedBotIds = JSON.parse(data);
            if (Array.isArray(loadedBotIds)) {
                knownBots = new Set(loadedBotIds);
                console.log(`Known bots loaded: ${loadedBotIds.length} bots`);
            } else {
                console.warn("Invalid format in known_bots.json. Starting with empty bots.");
                knownBots = new Set();
            }
        } else {
            console.log("No known_bots.json found. Starting with empty bots.");
            knownBots = new Set();
        }
    } catch (error) {
        console.error("Error loading known bots:", error);
        knownBots = new Set();
    }
}

function saveKnownBots() {
    try {
        const botIdsArray = Array.from(knownBots);
        fs.writeFileSync(knownBotsFilePath, JSON.stringify(botIdsArray, null, 2));
        console.log(`Known bots saved: ${botIdsArray.length} bots`);
    } catch (error) {
        console.error("Error saving known bots:", error);
    }
}

function isWhitelistedUser(message) {
    const username = message.author?.name;
    const displayName = message.author?.displayName;
    
    if (WHITELISTED_USERS.has(username) || WHITELISTED_USERS.has(displayName)) {
        console.log(`[Whitelist] User ${username || displayName} is whitelisted - will always respond`);
        return true;
    }
    return false;
}

function isBot(message) {
    if (isWhitelistedUser(message)) {
        return false;
    }
    
    const userId = message.createdById;
    const author = message.author;
    const content = message.content?.trim() || '';
    
    if (knownBots.has(userId)) {
        console.log(`[Bot Filter] Known bot detected: ${author?.name} (ID: ${userId})`);
        return true;
    }
    
    if (author?.type === "bot") {
        knownBots.add(userId);
        saveKnownBots();
        console.log(`[Bot Filter] Bot type detected: ${author?.name} (ID: ${userId})`);
        return true;
    }
    
    const botIndicators = [
        '🤖', '🔧', '⚙️', '🚀', '✅', '❌', '⚠️', '📊', '💡',
    ];
    
    if (botIndicators.some(indicator => content.startsWith(indicator))) {
        knownBots.add(userId);
        saveKnownBots();
        console.log(`[Bot Filter] Bot emoji detected in message from: ${author?.name} (ID: ${userId})`);
        return true;
    }
    
    const botResponsePatterns = [
        /^(hello!? i am now active|i am already active|i am not active|i am no longer active)/i,
        /^(to activate me, please use|the command has been sent to)/i,
        /^(sorry, (?:the|there was))/i,
        /^(too many requests)/i,
        /^(oops, something went wrong)/i,
        /^(\*\*\w+\*\* didn't provide)/i,
        /^\w+ has been (activated|deactivated|reset)/i,
        /^(processing|generating|thinking)/i,
        /^(error:|warning:|info:)/i,
        /^\[.*\]/i,
    ];
    
    if (botResponsePatterns.some(pattern => pattern.test(content))) {
        knownBots.add(userId);
        saveKnownBots();
        console.log(`[Bot Filter] Bot response pattern detected from: ${author?.name} (ID: ${userId})`);
        return true;
    }
    
    const username = author?.name?.toLowerCase() || '';
    const displayName = author?.displayName?.toLowerCase() || '';
    
    const botNamePatterns = [
        /bot$/, /^bot/, /-bot$/, /_bot$/, /ai$/, /^ai-/, /assistant/, /helper/, /service/, /automated/, /system/,
        new RegExp(`^${shapeUsername.toLowerCase()}`, 'i'),
    ];
    
    if (botNamePatterns.some(pattern => pattern.test(username) || pattern.test(displayName))) {
        knownBots.add(userId);
        saveKnownBots();
        console.log(`[Bot Filter] Bot name pattern detected: ${username} or ${displayName} (ID: ${userId})`);
        return true;
    }
    
    return false;
}

function detectRapidFireBot(channelId, userId, message) {
    if (isWhitelistedUser(message)) {
        return false;
    }
    
    const now = Date.now();
    
    if (!recentMessages.has(channelId)) {
        recentMessages.set(channelId, []);
    }
    
    const channelMessages = recentMessages.get(channelId);
    const validMessages = channelMessages.filter(msg => now - msg.timestamp < BOT_DETECTION_WINDOW);
    const userMessages = validMessages.filter(msg => msg.userId === userId);
    
    validMessages.push({ userId, timestamp: now });
    recentMessages.set(channelId, validMessages);
    
    if (userMessages.length >= MAX_MESSAGES_PER_USER) {
        knownBots.add(userId);
        saveKnownBots();
        console.log(`[Bot Filter] Rapid-fire bot detected: User ${userId} sent ${userMessages.length} messages in ${BOT_DETECTION_WINDOW/1000}s`);
        return true;
    }
    
    return false;
}

// NEW: Function to check if URL is a Guilded CDN URL
function isGuildedCdnUrl(url) {
    if (typeof url !== 'string') return false;
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname.includes('guilded') && 
               (parsedUrl.hostname.includes('cdn') || parsedUrl.pathname.includes('/asset/'));
    } catch (e) {
        return false;
    }
}

// NEW: Function to request signed URLs from Guilded API
async function getSignedUrls(urls) {
    if (!urls || urls.length === 0) return {};
    
    // Filter to only Guilded CDN URLs
    const guildedUrls = urls.filter(isGuildedCdnUrl);
    if (guildedUrls.length === 0) return {};
    
    // Check cache first
    const cachedUrls = {};
    const uncachedUrls = [];
    const now = Date.now();
    
    for (const url of guildedUrls) {
        const cached = signedUrlCache.get(url);
        if (cached && now < cached.expires) {
            cachedUrls[url] = { signedUrl: cached.signedUrl };
            console.log(`[Signed URL] Using cached signed URL for: ${url}`);
        } else {
            uncachedUrls.push(url);
        }
    }
    
    if (uncachedUrls.length === 0) {
        return cachedUrls;
    }
    
    try {
        console.log(`[Signed URL] Requesting signed URLs for ${uncachedUrls.length} URLs`);
        
        const response = await axios.post(
            `${GUILDED_API_BASE_URL}/url-signatures`,
            { urls: uncachedUrls },
            {
                headers: {
                    'Authorization': `Bearer ${guildedToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );
        
        if (response.data && response.data.urlSignatures) {
            const signatures = response.data.urlSignatures;
            const expires = now + SIGNED_URL_CACHE_DURATION;
            
            // Cache the signed URLs
            for (const [originalUrl, signedUrl] of Object.entries(signatures)) {
                signedUrlCache.set(originalUrl, { signedUrl, expires });
                cachedUrls[originalUrl] = { signedUrl };
            }
            
            console.log(`[Signed URL] Successfully obtained ${Object.keys(signatures).length} signed URLs`);
        }
        
        return cachedUrls;
    } catch (error) {
        console.error('[Signed URL] Error requesting signed URLs:', error.response ? error.response.data : error.message);
        
        // Fallback: return original URLs for non-Guilded URLs
        const fallback = {};
        for (const url of urls) {
            if (!isGuildedCdnUrl(url)) {
                fallback[url] = { signedUrl: url };
            }
        }
        return fallback;
    }
}

function getMediaType(url) {
    if (typeof url !== 'string') return null;
    try {
        if (!url.toLowerCase().startsWith('http://') && !url.toLowerCase().startsWith('https://')) {
            return null;
        }
        const parsedUrl = new URL(url);
        const path = parsedUrl.pathname.toLowerCase();
        const pathOnly = path.split('?')[0].split('#')[0];

        if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].some(ext => pathOnly.endsWith(ext))) return 'image';
        if (['.mp4', '.webm', '.mov'].some(ext => pathOnly.endsWith(ext))) return 'video';
        if (['.mp3', '.ogg', '.wav'].some(ext => pathOnly.endsWith(ext))) return 'audio';
        return null;
    } catch (e) {
        return null;
    }
}

function extractImageUrls(text) {
    if (typeof text !== 'string') return [];
    
    const imageUrls = [];
    const lines = text.split('\n');
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    
    for (const line of lines) {
        // Check for URLs wrapped in angle brackets
        const wrappedMatch = line.match(/<(https?:\/\/[^>]+)>/g);
        if (wrappedMatch) {
            wrappedMatch.forEach(match => {
                const url = match.slice(1, -1); // Remove < and >
                if (getMediaType(url) === 'image') {
                    imageUrls.push(url);
                }
            });
        }
        
        // Check for plain URLs
        const plainMatches = line.match(urlRegex);
        if (plainMatches) {
            plainMatches.forEach(url => {
                if (getMediaType(url) === 'image') {
                    imageUrls.push(url);
                }
            });
        }
    }
    
    return [...new Set(imageUrls)]; // Remove duplicates
}

// UPDATED: Format Shape response with signed URL support
async function formatShapeResponseForGuilded(shapeResponse) {
    if (typeof shapeResponse !== 'string' || shapeResponse.trim() === "") {
        return { content: shapeResponse };
    }

    // Extract all image URLs from the response
    const imageUrls = extractImageUrls(shapeResponse);
    
    if (imageUrls.length === 0) {
        return { content: shapeResponse };
    }

    // Get signed URLs for all image URLs
    const signedUrlMap = await getSignedUrls(imageUrls);
    
    // Create embeds using signed URLs where available
    const embeds = imageUrls.map(url => {
        const signedData = signedUrlMap[url];
        const finalUrl = signedData ? signedData.signedUrl : url;
        return { image: { url: finalUrl } };
    });
    
    // Clean up the content by removing wrapped URLs that are now embedded
    let cleanedContent = shapeResponse;
    imageUrls.forEach(url => {
        cleanedContent = cleanedContent.replace(new RegExp(`<${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'g'), '');
        cleanedContent = cleanedContent.replace(new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm'), '');
    });
    
    // Clean up extra whitespace and empty lines
    cleanedContent = cleanedContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
        .join('\n')
        .trim();

    if (cleanedContent === "") {
        return { embeds };
    } else {
        return { content: cleanedContent, embeds };
    }
}

async function sendMessageToShape(userId, channelId, content, guildId = null) {
    console.log(`[Shapes API] Sending message to ${SHAPES_MODEL_NAME}: User ${userId}, Channel ${channelId}, Guild ${guildId || 'N/A'}, Content: "${content}"`);
    try {
        const headers = {
            Authorization: `Bearer ${shapesApiKey}`,
            "Content-Type": "application/json",
            "X-User-Id": userId,
            "X-Channel-Id": channelId,
        };
        
        if (guildId) {
            headers["X-Guild-Id"] = guildId;
            console.log(`[Shapes API] Adding Guild ID to headers: ${guildId}`);
        }

        const response = await axios.post(
            `${SHAPES_API_BASE_URL}/chat/completions`,
            {
                model: SHAPES_MODEL_NAME,
                messages: [{ role: "user", content: content }],
            },
            {
                headers: headers,
                timeout: 60000,
            }
        );

        if (response.data?.choices?.length > 0) {
            const shapeResponseContent = response.data.choices[0].message.content;
            const isBot = response.data.choices[0].message.isBot || false;
            
            console.log(`[Shapes API] Response received: "${shapeResponseContent}", isBot: ${isBot}`);
            
            if (isBot) {
                knownBots.add(userId);
                saveKnownBots();
                console.log(`Marked user ${userId} as bot based on API response`);
            }
            
            return {
                content: shapeResponseContent,
                isBot: isBot
            };
        }
        console.warn("[Shapes API] Unexpected response structure or empty choices:", response.data);
        return { content: "", isBot: false };
    } catch (error) {
        console.error("[Shapes API] Error during communication:", error.response ? error.response.data : error.message);
        if (error.code === 'ECONNABORTED' || error.message.toLowerCase().includes('timeout')) {
            return { content: "Sorry, the request to the Shape timed out.", isBot: false };
        }
        if (error.response?.status === 429) {
            return { content: "Too many requests to the Shapes API. Please try again later.", isBot: false };
        }
        if (error.response?.status === 500) {
            console.error("[Shapes API] Server error - API may be down or misconfigured");
            return { content: "The Shape service is temporarily unavailable. Please try again later.", isBot: false };
        }
        throw error;
    }
}

async function processShapeApiCommand(guildedMessage, guildedCommandName, baseShapeCommand, requiresArgs = false, commandArgs = []) {
    const channelId = guildedMessage.channelId;
    const userId = guildedMessage.createdById;
    const guildId = guildedMessage.serverId || guildedMessage.guildId || null;

    console.log(`[Debug] Processing command /${guildedCommandName} - Guild/Server ID: ${guildId || 'NOT FOUND'}`);

    if (!activeChannels.has(channelId)) {
        await guildedMessage.reply(NOT_ACTIVE_MESSAGE());
        return;
    }

    let fullShapeCommand = baseShapeCommand;
    if (requiresArgs) {
        const argString = commandArgs.join(" ");
        if (!argString) {
            await guildedMessage.reply(`Please provide the necessary arguments for \`/${guildedCommandName}\`. Example: \`/${guildedCommandName} your arguments\``);
            return;
        }
        fullShapeCommand = `${baseShapeCommand} ${argString}`;
    }

    console.log(`[Bot Command: /${guildedCommandName}] Sending to Shape API: User ${userId}, Channel ${channelId}, Guild ${guildId || 'N/A'}, Content: "${fullShapeCommand}"`);
    
    try {
        await client.rest.put(`/channels/${channelId}/typing`);
    } catch (typingError) {
        console.warn(`[Typing Indicator] Error for /${guildedCommandName}:`, typingError.message);
    }

    try {
        const shapeResponse = await sendMessageToShape(userId, channelId, fullShapeCommand, guildId);

        if (shapeResponse?.content?.trim() !== "") {
            const replyPayload = await formatShapeResponseForGuilded(shapeResponse.content);
            if (typeof replyPayload.content === 'string' && (replyPayload.content.startsWith("Sorry,") || replyPayload.content.startsWith("Too many requests") || replyPayload.content.startsWith("The Shape service"))) {
                await guildedMessage.reply(replyPayload.content);
            } else {
                await guildedMessage.reply(replyPayload);
            }
        } else {
            if (baseShapeCommand === "!reset") {
                await guildedMessage.reply(START_MESSAGE_RESET());
            } else if (["!sleep", "!wack"].includes(baseShapeCommand)) {
                await guildedMessage.reply(`The command \`/${guildedCommandName}\` has been sent to **${shapeUsername}**. It may have been processed silently.`);
            } else {
                await guildedMessage.reply(`**${shapeUsername}** didn't provide a specific textual response for \`/${guildedCommandName}\`. The action might have been completed, or it may require a different interaction.`);
            }
        }
    } catch (error) {
        console.error(`[Bot Command: /${guildedCommandName}] Error during Shapes API call or Guilded reply:`, error);
        await guildedMessage.reply(`Sorry, there was an error processing your \`/${guildedCommandName}\` command with **${shapeUsername}**.`);
    }
}

// --- Main Bot Logic ---

loadActiveChannels();
loadKnownBots();

client.on("ready", () => {
    console.log(`Bot logged in as ${client.user?.name}!`);
    console.log(`Ready to process messages for Shape: ${shapeUsername} (Model: ${SHAPES_MODEL_NAME}).`);
    console.log(`Active channels on startup: ${Array.from(activeChannels).join(', ') || 'None'}`);
    console.log(`Known bots loaded: ${knownBots.size} bots`);
    console.log(`Whitelisted users: ${Array.from(WHITELISTED_USERS).join(', ')}`);
});

client.on("messageCreated", async (message) => {
    const userId = message.createdById;
    const channelId = message.channelId;
    const author = message.author;
    const guildId = message.serverId || message.guildId || null;
    
    console.log(`[Message Debug] Received message from: ${author?.name} (ID: ${userId}), Type: ${author?.type}, Guild/Server ID: ${guildId || 'NOT FOUND'}, Content: "${message.content?.substring(0, 50)}..."`);
    
    // CRITICAL: Ignore messages from this bot itself
    if (userId === client.user?.id) {
        console.log(`[Bot Filter] *** IGNORING MESSAGE FROM SELF *** ${client.user?.name}`);
        return;
    }
    
    const isUserWhitelisted = isWhitelistedUser(message);
    
    if (!isUserWhitelisted) {
        if (detectRapidFireBot(channelId, userId, message)) {
            console.log(`[Bot Filter] *** BLOCKING RAPID-FIRE BOT *** ${author?.name} (ID: ${userId})`);
            return;
        }
        
        if (isBot(message)) {
            console.log(`[Bot Filter] *** BLOCKING MESSAGE FROM BOT *** ${author?.name} (ID: ${userId})`);
            return;
        }
    }
    
    if (!message.content?.trim()) {
        console.log(`[Bot Filter] Ignoring empty message from: ${author?.name}`);
        return;
    }

    const commandPrefix = "/";
    const guildedUserName = author?.name || "Unknown User";

    console.log(`[Message Processing] Processing message from ${isUserWhitelisted ? 'WHITELISTED' : 'human'} user: ${guildedUserName} in channel: ${channelId}, guild: ${guildId || 'N/A'}`);

    // Handle commands
    if (message.content.startsWith(commandPrefix)) {
        const [command, ...args] = message.content.slice(commandPrefix.length).trim().split(/\s+/);
        const lowerCaseCommand = command.toLowerCase();

        // Bot-specific commands
        if (lowerCaseCommand === "activate") {
            if (args[0] !== shapeUsername) {
                return message.reply(INCORRECT_ACTIVATE_MESSAGE());
            }
            
            if (activeChannels.has(channelId)) {
                return message.reply(ALREADY_ACTIVE_MESSAGE());
            }
            
            activeChannels.add(channelId);
            saveActiveChannels();
            console.log(`Bot activated in channel: ${channelId}, guild: ${guildId || 'N/A'}`);
            return message.reply(START_MESSAGE_ACTIVATE());
        }

        if (lowerCaseCommand === "deactivate") {
            if (!activeChannels.has(channelId)) {
                return message.reply(NOT_ACTIVE_MESSAGE());
            }
            
            activeChannels.delete(channelId);
            saveActiveChannels();
            console.log(`Bot deactivated in channel: ${channelId}, guild: ${guildId || 'N/A'}`);
            return message.reply(DEACTIVATE_MESSAGE());
        }

        // Add a command to clear known bots (useful for debugging)
        if (lowerCaseCommand === "clearbots" && author?.name === "YourAdminUsername") { // Replace with your admin username
            knownBots.clear();
            saveKnownBots();
            return message.reply("🤖 Known bots list has been cleared.");
        }

        // Only process other commands in active channels
        if (!activeChannels.has(channelId)) {
            return message.reply(NOT_ACTIVE_MESSAGE());
        }

        // Shapes API commands
        switch (lowerCaseCommand) {
            case "reset":
                return processShapeApiCommand(message, "reset", "!reset");
            case "sleep":
                return processShapeApiCommand(message, "sleep", "!sleep");
            case "dashboard":
                return processShapeApiCommand(message, "dashboard", "!dashboard");
            case "info":
                return processShapeApiCommand(message, "info", "!info");
            case "web":
                return processShapeApiCommand(message, "web", "!web", true, args);
            case "help":
                return processShapeApiCommand(message, "help", "!help");
            case "imagine":
                return processShapeApiCommand(message, "imagine", "!imagine", true, args);
            case "wack":
                return processShapeApiCommand(message, "wack", "!wack");
            default:
                return;
        }
    }

        // Only process other commands in active channels
        if (!activeChannels.has(channelId)) {
            return message.reply(NOT_ACTIVE_MESSAGE());
        }

        // Shapes API commands
        switch (lowerCaseCommand) {
            case "reset":
                return processShapeApiCommand(message, "reset", "!reset");
            case "sleep":
                return processShapeApiCommand(message, "sleep", "!sleep");
            case "dashboard":
                return processShapeApiCommand(message, "dashboard", "!dashboard");
            case "info":
                return processShapeApiCommand(message, "info", "!info");
            case "web":
                return processShapeApiCommand(message, "web", "!web", true, args);
            case "help":
                return processShapeApiCommand(message, "help", "!help");
            case "imagine":
                return processShapeApiCommand(message, "imagine", "!imagine", true, args);
            case "wack":
                return processShapeApiCommand(message, "wack", "!wack");
            default:
                // Ignore unknown commands in active channels
                return;
        }
    }

    // Only process regular messages in active channels
    if (!activeChannels.has(channelId)) {
        return;
    }

    // Process regular messages in active channels
    const originalContent = message.content;
    const contentForShape = `${guildedUserName}: ${originalContent}`;

    console.log(`[Regular Message] User ${userId} (${guildedUserName}) in active channel ${channelId}, guild ${guildId || 'N/A'}: "${originalContent}"`);
    console.log(`[Regular Message] Sending to Shape: "${contentForShape}"`);

    try {
        await client.rest.put(`/channels/${channelId}/typing`);
    } catch (typingError) {
        console.warn("[Typing Indicator] Error sending typing indicator:", typingError.message);
    }

    try {
        const shapeResponse = await sendMessageToShape(userId, channelId, contentForShape, guildId);

        if (shapeResponse?.content?.trim()) {
            const replyPayload = formatShapeResponseForGuilded(shapeResponse.content);
            if (typeof replyPayload.content === 'string' && (replyPayload.content.startsWith("Sorry,") || replyPayload.content.startsWith("Too many requests") || replyPayload.content.startsWith("The Shape service"))) {
                await message.reply(replyPayload.content);
            } else {
                await message.reply(replyPayload);
            }
        } else {
            console.log("[Regular Message] No valid response from Shapes API or response was empty.");
        }
    } catch (err) {
        console.error("[Regular Message] Error sending message to Shape or response to Guilded:", err);
        try {
            await message.reply("Oops, something went wrong while trying to talk to the Shape.");
        } catch (replyError) {
            console.error("Could not send error message to Guilded:", replyError);
        }
    }
});

client.on("error", (error) => {
    console.error("An error occurred in the Guilded Client:", error);
});

client.login(guildedToken);
console.log("Bot starting...");
