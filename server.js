const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();

// Function to ensure Canva CLI credentials exist
function ensureCanvaCredentials() {
    const credentialsDir = path.join(os.homedir(), '.canva-cli');
    const credentialsFile = path.join(credentialsDir, 'credentials');
    
    // Check if credentials already exist
    if (fs.existsSync(credentialsFile)) {
        console.log('Canva credentials already exist');
        return;
    }
    
    // Create credentials from environment variable if available
    const credentialsDataBase64 = process.env.CANVA_CREDENTIALS_BASE64;
    const credentialsDataRaw = process.env.CANVA_CREDENTIALS;
    
    if (credentialsDataBase64 || credentialsDataRaw) {
        try {
            // Create directory if it doesn't exist
            if (!fs.existsSync(credentialsDir)) {
                fs.mkdirSync(credentialsDir, { recursive: true });
            }
            
            // Decode credentials data
            let credentialsData;
            if (credentialsDataBase64) {
                credentialsData = Buffer.from(credentialsDataBase64, 'base64').toString('utf8');
                console.log('Using base64 encoded credentials');
            } else {
                credentialsData = credentialsDataRaw;
                console.log('Using raw credentials');
            }
            
            // Write credentials file
            fs.writeFileSync(credentialsFile, credentialsData);
            console.log('Canva credentials created from environment variable');
        } catch (error) {
            console.error('Failed to create credentials file:', error);
        }
    } else {
        console.log('No CANVA_CREDENTIALS_BASE64 or CANVA_CREDENTIALS environment variable found');
    }
}
app.use(express.json()); // Middleware to parse JSON bodies

// Add CORS headers to allow browser requests
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

const PORT = process.env.PORT || 3000;
// Fixed local callback port for mcp-remote (can override via env)
const MCP_LOCAL_PORT = parseInt(process.env.MCP_LOCAL_PORT || '3334', 10);

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Canva MCP Proxy Server is running' });
});

// Test endpoint to check OAuth URL validity
app.get('/test-oauth-url', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter required' });
    }
    
    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(url, { method: 'HEAD' });
        res.json({
            url: url,
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries())
        });
    } catch (error) {
        res.json({
            url: url,
            error: error.message,
            type: error.constructor.name
        });
    }
});

// Manual callback URL submission endpoint (now forwards to local mcp-remote callback)
app.post('/api/oauth/callback', async (req, res) => {
    const { callbackUrl } = req.body;
    
    if (!callbackUrl) {
        return res.status(400).json({ 
            error: 'Callback URL is required',
            message: 'Please provide the callback URL from Canva authorization'
        });
    }
    
    try {
        const parsed = new URL(callbackUrl);
        const search = parsed.search || '';
        const fetch = (await import('node-fetch')).default;

        // Try multiple local callback paths to match mcp-remote
        const candidatePaths = ['/callback', '/oauth/callback'];
        let delivered = false;
        let lastStatus = 0;
        let lastBody = '';
        for (const path of candidatePaths) {
            const forwardUrl = `http://127.0.0.1:${MCP_LOCAL_PORT}${path}${search}`;
            console.log(`[OAuth Manual] Forwarding pasted callback to mcp-remote: ${forwardUrl}`);
            const response = await fetch(forwardUrl, { method: 'GET' });
            lastStatus = response.status;
            lastBody = await response.text();
            if (response.ok) { delivered = true; break; }
            console.warn(`[OAuth Manual] mcp-remote callback at ${path} responded ${lastStatus}`);
        }
        if (!delivered) {
            return res.status(502).json({
                error: 'Failed to deliver callback to auth coordinator',
                status: lastStatus,
                body: lastBody
            });
        }

        const code = parsed.searchParams.get('code');
        const state = parsed.searchParams.get('state');
        return res.json({
            success: true,
            message: 'Authorization code delivered. You can retry your request now.',
            code,
            state
        });
    } catch (error) {
        console.error('Error handling manual callback URL:', error);
        res.status(400).json({
            error: 'Invalid callback URL',
            message: 'Could not parse or forward the provided callback URL',
            details: error.message
        });
    }
});

// OAuth callback endpoint to handle Canva authorization (proxy variant)
app.get('/oauth/mcp/callback', async (req, res) => {
    try {
        const originalQuery = req.url.split('?')[1] || '';
        const forwardUrl = `http://127.0.0.1:${MCP_LOCAL_PORT}/callback${originalQuery ? `?${originalQuery}` : ''}`;
        console.log(`[OAuth Proxy] Forwarding callback to mcp-remote: ${forwardUrl}`);
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(forwardUrl, { method: 'GET' });
        const text = await response.text();
        const ok = response.ok;
        console.log(`[OAuth Proxy] mcp-remote callback response (${response.status}): ${text.substring(0, 200)}...`);
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${ok ? 'Authorization Successful' : 'Authorization Handling Error'}</title>
                <style>
                    body { font-family: Arial, sans-serif; max-width: 700px; margin: 50px auto; padding: 20px; text-align: center; }
                    .box { background: ${ok ? '#d4edda' : '#f8d7da'}; border: 2px solid ${ok ? '#c3e6cb' : '#f5c6cb'}; padding: 20px; border-radius: 8px; }
                    .small { color: #666; margin-top: 12px; font-size: 12px; }
                    .button { background: ${ok ? '#28a745' : '#dc3545'}; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
                </style>
            </head>
            <body>
                <div class="box">
                    <h2>${ok ? '🎉 Authorization Completed' : '⚠️ Authorization Could Not Be Completed'}</h2>
                    <p>${ok ? 'You can now return to the application.' : 'Please try again or contact support.'}</p>
                    <button class="button" onclick="window.close()">Close Tab</button>
                    <div class="small">Internal status: ${response.status}</div>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        console.error('[OAuth Proxy] Error forwarding callback:', err);
        return res.status(500).send('Internal error handling OAuth callback');
    }
});

// Also support plain '/callback' for providers that redirect here
app.get('/callback', async (req, res) => {
    try {
        const originalQuery = req.url.split('?')[1] || '';
        const forwardUrl = `http://127.0.0.1:${MCP_LOCAL_PORT}/callback${originalQuery ? `?${originalQuery}` : ''}`;
        console.log(`[OAuth Proxy] Forwarding /callback to mcp-remote: ${forwardUrl}`);
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(forwardUrl, { method: 'GET' });
        const text = await response.text();
        const ok = response.ok;
        console.log(`[OAuth Proxy] mcp-remote /callback response (${response.status}): ${text.substring(0, 200)}...`);
        return res.status(ok ? 200 : 502).send(ok ? 'OK' : 'Callback handling error');
    } catch (err) {
        console.error('[OAuth Proxy] Error forwarding /callback:', err);
        return res.status(500).send('Internal error handling OAuth callback');
    }
});

// This is the API endpoint your client will hit
app.post('/api/mcp', (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    console.log("Ensuring Canva credentials exist...");
    ensureCanvaCredentials();

    console.log("Starting Canva MCP process...");
    const baseUrl = req.get('host') ? `https://${req.get('host')}` : 'http://localhost:3000';
    const baseHost = req.get('host') || 'localhost:3000';
    
    const mcpEnv = {
        ...process.env,
        NODE_ENV: 'production',
        CANVA_ACCESS_TOKEN: process.env.CANVA_ACCESS_TOKEN,
        CANVA_CLIENT_ID: process.env.CANVA_CLIENT_ID,
        CANVA_CLIENT_SECRET: process.env.CANVA_CLIENT_SECRET,
        CANVA_CREDENTIALS_BASE64: process.env.CANVA_CREDENTIALS_BASE64,
        CANVA_CREDENTIALS: process.env.CANVA_CREDENTIALS,
        OAUTH_REDIRECT_URI: `${baseUrl}/callback`,
        CI: 'true',
        NO_BROWSER: 'true',
        HEADLESS: 'true'
    };
    
    console.log('Environment variables set:', Object.keys(mcpEnv).filter(k => k.startsWith('CANVA') || ['CI', 'NO_BROWSER', 'HEADLESS'].includes(k)));
    
    // Revert to local callback listener to use allowed redirect hosts (e.g., localhost)
    const mcpArgs = ['-y', 'mcp-remote@latest', 'https://mcp.canva.com/mcp', String(MCP_LOCAL_PORT)];
    console.log(`Spawning mcp-remote with args: ${JSON.stringify(mcpArgs)}`);
    const mcpProcess = spawn('npx', mcpArgs, {
        env: mcpEnv
    });

    let responseData = '';
    let errorData = '';
    let authInProgress = false;
    let timeout;
    let jsonBuffer = '';
    let responded = false;
    let initSent = false;
    let initDone = false;
    let listedDone = false;
    let toolRequestPending = null;

    mcpProcess.stdout.on('data', (data) => {
        const chunk = data.toString();
        responseData += chunk;
        jsonBuffer += chunk;
        // Parse newline-delimited JSON responses
        let index;
        while ((index = jsonBuffer.indexOf('\n')) >= 0) {
            const line = jsonBuffer.slice(0, index).trim();
            jsonBuffer = jsonBuffer.slice(index + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                // initialize response → then list tools
                if (msg.id === 1 && !initDone) {
                    initDone = true;
                    // Send tools/list next
                    const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
                    mcpProcess.stdin.write(JSON.stringify(listReq) + '\n');
                }
                // tools/list response → then call our selected tool
                if (msg.id === 2 && !listedDone) {
                    listedDone = true;
                    if (toolRequestPending) {
                        mcpProcess.stdin.write(JSON.stringify(toolRequestPending) + '\n');
                    }
                }
                // Tool call response (id 3 per our request)
                if (msg.id === 3 && !responded) {
                    responded = true;
                    if (timeout) clearTimeout(timeout);
                    try { mcpProcess.kill(); } catch (_) {}
                    if (!res.headersSent) {
                        if (msg.error) {
                            return res.status(502).json({ error: 'Tool call failed', details: msg.error, raw: msg });
                        }
                        return res.status(200).json({ success: true, result: msg.result ?? null, raw: msg });
                    }
                }
            } catch (e) {
                // Not a JSON line; ignore (mcp-remote logs, etc.)
            }
        }
        console.log(`MCP stdout: ${chunk}`);
    });

    mcpProcess.stderr.on('data', (data) => {
        const dataStr = data.toString();
        errorData += dataStr;
        console.error(`MCP stderr: ${dataStr}`);
        
        const authUrlMatch = dataStr.match(/Please authorize this client by visiting:\s*(https?:\/\/[^\s]+)/);
        if (authUrlMatch) {
            const originalUrl = authUrlMatch[1];
            const authUrl = originalUrl; // Do NOT rewrite redirect_uri; use manual/paste flow
            console.log(`Found OAuth URL (no rewrite): ${authUrl}`);
            
            if (!authInProgress) {
                authInProgress = true;
                if (timeout) clearTimeout(timeout);
                timeout = setTimeout(() => {
                    console.log('MCP process auth timeout, killing process');
                    mcpProcess.kill();
                    if (!res.headersSent) {
                        res.status(401).json({ 
                            error: 'OAuth Authentication Timed Out',
                            details: 'No authorization completed within the allowed timeframe.',
                            authUrl
                        });
                    }
                }, 5 * 60 * 1000);
            }
            
            if (!res.headersSent) {
                res.status(200).json({
                    authorize: true,
                    message: 'Authorization required. Open the URL, approve, then if redirected to localhost copy the full URL and paste it below.',
                    authUrl,
                    callback: `${baseUrl}/oauth/mcp/callback`,
                    manualPaste: true
                });
            }
        }
    });

    timeout = setTimeout(() => {
        console.log('MCP process timeout, killing process');
        mcpProcess.kill();
        if (!res.headersSent) {
            if (errorData.includes('Please authorize') || errorData.includes('Authentication required')) {
                res.status(401).json({ 
                    error: 'OAuth Authentication Required',
                    details: 'Authorization required. Use the provided auth URL, and if redirected to localhost, paste that URL into the client.',
                    partialError: errorData
                });
            } else {
                res.status(408).json({ 
                    error: 'MCP process timeout',
                    details: 'Process took too long to respond',
                    partialResponse: responseData,
                    partialError: errorData
                });
            }
        }
    }, 30000);

    mcpProcess.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        console.log(`MCP process exited with code ${code}`);
        console.log(`Response data length: ${responseData.length}`);
        console.log(`Error data length: ${errorData.length}`);
        
        if (!res.headersSent) {
            if (code !== 0) {
                if (errorData.includes('Please authorize') || errorData.includes('Authentication required') || errorData.includes('Browser opened')) {
                    return res.status(401).json({ 
                        error: 'OAuth Authentication Required',
                        exitCode: code,
                        details: 'Authorization is required. After approving in the browser, paste the localhost callback URL in the client.',
                        partialError: errorData,
                        partialResponse: responseData
                    });
                }
                
                return res.status(500).json({ 
                    error: 'MCP process failed.', 
                    exitCode: code,
                    details: errorData || 'No error details available',
                    partialResponse: responseData
                });
            }
            
            res.json({ 
                success: true,
                response: responseData || 'MCP process completed successfully',
                exitCode: code,
                hasError: errorData.length > 0,
                errorDetails: errorData
            });
        }
    });

    mcpProcess.on('error', (error) => {
        if (timeout) clearTimeout(timeout);
        console.error('MCP process error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Failed to start MCP process',
                details: error.message
            });
        }
    });

    const initRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {
                tools: {}
            },
            clientInfo: {
                name: "canva-mcp-proxy",
                version: "1.0.0"
            }
        }
    };

    console.log(`Initializing MCP connection:`, JSON.stringify(initRequest));
    mcpProcess.stdin.write(JSON.stringify(initRequest) + '\n');
    initSent = true;

    // Prepare the tools/call request; send it only after tools/list response
    if (prompt.toLowerCase().includes('design') || prompt.toLowerCase().includes('create')) {
        toolRequestPending = {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'generate-design', arguments: { query: prompt } }
        };
    } else if (prompt.toLowerCase().includes('search') || prompt.toLowerCase().includes('find')) {
        toolRequestPending = {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'search-designs', arguments: { query: prompt } }
        };
    } else {
        toolRequestPending = {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'generate-design', arguments: { query: prompt } }
        };
    }
    console.log(`Prepared tool call:`, JSON.stringify(toolRequestPending));
});

app.listen(PORT, () => {
    console.log(`MCP Proxy Server listening on port ${PORT}`);
});