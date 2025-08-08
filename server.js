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

// Manual callback URL submission endpoint
app.post('/api/oauth/callback', (req, res) => {
    const { callbackUrl } = req.body;
    
    if (!callbackUrl) {
        return res.status(400).json({ 
            error: 'Callback URL is required',
            message: 'Please provide the callback URL from Canva authorization'
        });
    }
    
    try {
        // Parse the callback URL to extract query parameters
        const url = new URL(callbackUrl);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        const error_description = url.searchParams.get('error_description');
        
        console.log(`Manual callback received - Code: ${!!code}, State: ${state}, Error: ${error}`);
        
        if (error) {
            return res.status(400).json({
                error: 'Authorization failed',
                details: error,
                description: error_description
            });
        }
        
        if (!code) {
            return res.status(400).json({
                error: 'No authorization code found',
                message: 'The callback URL did not contain an authorization code'
            });
        }
        
        // Store the authorization code for the MCP process to use
        global.oauthCode = code;
        global.oauthState = state;
        
        res.json({
            success: true,
            message: 'Authorization code received successfully',
            code: code,
            state: state,
            instructions: 'You can now retry your original request - the server is authenticated!'
        });
        
    } catch (error) {
        console.error('Error parsing callback URL:', error);
        res.status(400).json({
            error: 'Invalid callback URL',
            message: 'Could not parse the provided callback URL',
            details: error.message
        });
    }
});

// OAuth callback endpoint to handle Canva authorization
app.get('/oauth/callback', (req, res) => {
    const { code, state, error, error_description } = req.query;
    
    console.log(`OAuth callback received:`, { code: !!code, state, error, error_description, fullQuery: req.query });
    
    if (error) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Authorization Error</title>
                <style>
                    body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
                    .error { background: #f8d7da; border: 2px solid #f5c6cb; padding: 20px; border-radius: 8px; }
                    .code { background: #f8f9fa; padding: 10px; border-radius: 4px; font-family: monospace; margin: 10px 0; }
                    .button { background: #dc3545; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
                </style>
            </head>
            <body>
                <div class="error">
                    <h2>❌ Authorization Failed</h2>
                    <p><strong>Error:</strong> ${error}</p>
                    ${error_description ? `<p><strong>Description:</strong> ${error_description}</p>` : ''}
                    <p>Please try the authorization process again or contact support.</p>
                    <button class="button" onclick="window.close()">Close Tab</button>
                </div>
            </body>
            </html>
        `);
    }
    
    if (!code) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Authorization Issue</title>
                <style>
                    body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
                    .warning { background: #fff3cd; border: 2px solid #ffeaa7; padding: 20px; border-radius: 8px; }
                    .debug { background: #f8f9fa; padding: 10px; border-radius: 4px; font-family: monospace; margin: 10px 0; text-align: left; }
                </style>
            </head>
            <body>
                <div class="warning">
                    <h2>⚠️ No Authorization Code Received</h2>
                    <p>The OAuth callback did not include an authorization code.</p>
                    <div class="debug">Query Parameters: ${JSON.stringify(req.query, null, 2)}</div>
                    <p>This might indicate an issue with the Canva authorization server or the OAuth flow.</p>
                    <button onclick="window.close()">Close Tab</button>
                </div>
            </body>
            </html>
        `);
    }

    console.log(`Received OAuth callback - Code: ${code}, State: ${state}`);
    
    // Store the authorization code temporarily (in a real app, you'd use Redis or similar)
    global.oauthCode = code;
    global.oauthState = state;
    
    // Return a success page
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Authorization Successful</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
                .success { background: #d4edda; border: 2px solid #c3e6cb; padding: 20px; border-radius: 8px; }
                .code { background: #f8f9fa; padding: 10px; border-radius: 4px; font-family: monospace; margin: 10px 0; }
                .button { background: #28a745; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
            </style>
        </head>
        <body>
            <div class="success">
                <h2>🎉 Authorization Successful!</h2>
                <p>You have successfully authorized the Canva MCP server.</p>
                <div class="code">Authorization Code: ${code}</div>
                <p>You can now close this tab and return to your application to make requests.</p>
                <button class="button" onclick="window.close()">Close Tab</button>
            </div>
        </body>
        </html>
    `);
});

// NEW: Public callback that proxies to mcp-remote's local callback listener
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

// This is the API endpoint your client will hit
app.post('/api/mcp', (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    console.log("Ensuring Canva credentials exist...");
    ensureCanvaCredentials();

    console.log("Starting Canva MCP process...");
    // Use the actual Canva MCP server (not the dev documentation server)
    // Determine the base URL for OAuth redirect
    const baseUrl = req.get('host') ? `https://${req.get('host')}` : 'http://localhost:3000';
    
    // Set up environment for OAuth authentication
    const mcpEnv = {
        ...process.env,
        NODE_ENV: 'production',
        // Add any OAuth tokens if available
        CANVA_ACCESS_TOKEN: process.env.CANVA_ACCESS_TOKEN,
        CANVA_CLIENT_ID: process.env.CANVA_CLIENT_ID,
        CANVA_CLIENT_SECRET: process.env.CANVA_CLIENT_SECRET,
        // Keep existing credentials approach as fallback
        CANVA_CREDENTIALS_BASE64: process.env.CANVA_CREDENTIALS_BASE64,
        CANVA_CREDENTIALS: process.env.CANVA_CREDENTIALS,
        // Set the OAuth redirect URI to our Railway server
        OAUTH_REDIRECT_URI: `${baseUrl}/oauth/mcp/callback`,
        // Disable interactive authentication
        CI: 'true',
        NO_BROWSER: 'true',
        HEADLESS: 'true'
    };
    
    console.log('Environment variables set:', Object.keys(mcpEnv).filter(k => k.startsWith('CANVA') || ['CI', 'NO_BROWSER', 'HEADLESS'].includes(k)));
    
    // IMPORTANT: fix the local port so we can proxy the callback back to mcp-remote
    const mcpArgs = ['-y', 'mcp-remote@latest', 'https://mcp.canva.com/mcp', String(MCP_LOCAL_PORT)];
    console.log(`Spawning mcp-remote with args: ${JSON.stringify(mcpArgs)}`);
    const mcpProcess = spawn('npx', mcpArgs, {
        env: mcpEnv
    });

    let responseData = '';
    let errorData = '';
    let authInProgress = false;
    let timeout;

    // Listen for data coming out of the MCP process
    mcpProcess.stdout.on('data', (data) => {
        responseData += data.toString();
        console.log(`MCP stdout: ${data}`);
    });

    // Listen for any errors and extract OAuth URLs
    mcpProcess.stderr.on('data', (data) => {
        const dataStr = data.toString();
        errorData += dataStr;
        console.error(`MCP stderr: ${dataStr}`);
        
        // Check for OAuth authorization URL
        const authUrlMatch = dataStr.match(/Please authorize this client by visiting:\s*(https?:\/\/[^\s]+)/);
        if (authUrlMatch) {
            let authUrl = authUrlMatch[1];
            console.log(`Found OAuth URL: ${authUrl}`);
            
            // Replace localhost redirect URI with our server URL that proxies to mcp-remote local callback
            const publicCallbackUrl = `${baseUrl}/oauth/mcp/callback`;
            const railwayCallbackUrl = encodeURIComponent(publicCallbackUrl);
            
            console.log(`Base URL: ${baseUrl}`);
            console.log(`Public callback URL: ${publicCallbackUrl}`);
            console.log(`Original OAuth URL: ${authUrl}`);
            
            const originalUrl = authUrl;
            authUrl = authUrl.replace(/redirect_uri=([^&]+)/, `redirect_uri=${railwayCallbackUrl}`);
            
            // If that didn't work, try URL decoding first
            if (authUrl === originalUrl) {
                const decodedUrl = decodeURIComponent(authUrl);
                console.log(`Trying with decoded URL: ${decodedUrl}`);
                authUrl = decodedUrl.replace(/redirect_uri=([^&]+)/, `redirect_uri=${railwayCallbackUrl}`);
                authUrl = encodeURI(authUrl);
            }
            
            // As a last resort, aggressive replacement of common localhost encodings
            if (authUrl === originalUrl || authUrl.includes('localhost')) {
                console.log('Doing aggressive localhost replacement...');
                authUrl = authUrl.replace(/http%3A%2F%2Flocalhost%3A\d+%2Fcallback/, railwayCallbackUrl);
                authUrl = authUrl.replace(/http:\/\/localhost:\d+\/callback/, publicCallbackUrl);
            }
            
            console.log(`Final modified OAuth URL: ${authUrl}`);
            
            // Extend timeout while we wait for human consent
            if (!authInProgress) {
                authInProgress = true;
                if (timeout) clearTimeout(timeout);
                // Give up to 5 minutes for the user to click Allow and be redirected
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
                // Return immediate response with the human-facing auth URL
                res.status(200).json({
                    authorize: true,
                    message: 'Authorization required. Visit the URL to grant access, then retry your request.',
                    authUrl,
                    callback: publicCallbackUrl
                });
            }
        }
    });

    // Set a timeout for the MCP process (will be overridden if auth is in progress)
    timeout = setTimeout(() => {
        console.log('MCP process timeout, killing process');
        mcpProcess.kill();
        if (!res.headersSent) {
            // Check if this is an OAuth authentication issue
            if (errorData.includes('Please authorize') || errorData.includes('Authentication required')) {
                res.status(401).json({ 
                    error: 'OAuth Authentication Required',
                    details: 'The Canva MCP server requires OAuth authentication. Visit the provided auth URL from a previous response, then retry.',
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
    }, 30000); // 30 second default timeout

    // When the process closes, send the response back to your client
    mcpProcess.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        console.log(`MCP process exited with code ${code}`);
        console.log(`Response data length: ${responseData.length}`);
        console.log(`Error data length: ${errorData.length}`);
        
        if (!res.headersSent) {
            if (code !== 0) {
                // Check if this is an OAuth authentication issue
                if (errorData.includes('Please authorize') || errorData.includes('Authentication required') || errorData.includes('Browser opened')) {
                    return res.status(401).json({ 
                        error: 'OAuth Authentication Required',
                        exitCode: code,
                        details: 'Authorization is required and must be completed via the provided URL. After authorizing, retry your request.',
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
            
            // Return success even if no response data (MCP might not produce output for some commands)
            res.json({ 
                success: true,
                response: responseData || 'MCP process completed successfully',
                exitCode: code,
                hasError: errorData.length > 0,
                errorDetails: errorData
            });
        }
    });

    // Handle process errors
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

    // MCP protocol: First initialize the connection
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

    // Wait a moment then send the actual request
    setTimeout(() => {
        const toolRequest = {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list"
        };
        
        console.log(`Listing available tools:`, JSON.stringify(toolRequest));
        mcpProcess.stdin.write(JSON.stringify(toolRequest) + '\n');
        
        // Use the appropriate tool from the actual Canva MCP server
        setTimeout(() => {
            let toolRequest;
            
            // If asking about design/creation, try to generate a design
            if (prompt.toLowerCase().includes('design') || prompt.toLowerCase().includes('create')) {
                toolRequest = {
                    jsonrpc: "2.0",
                    id: 3,
                    method: "tools/call",
                    params: {
                        name: "generate-design",
                        arguments: {
                            query: prompt
                        }
                    }
                };
            } 
            // If asking about search, use search-designs
            else if (prompt.toLowerCase().includes('search') || prompt.toLowerCase().includes('find')) {
                toolRequest = {
                    jsonrpc: "2.0",
                    id: 3,
                    method: "tools/call",
                    params: {
                        name: "search-designs",
                        arguments: {
                            query: prompt
                        }
                    }
                };
            }
            // Default to generate-design for general requests
            else {
                toolRequest = {
                    jsonrpc: "2.0",
                    id: 3,
                    method: "tools/call",
                    params: {
                        name: "generate-design",
                        arguments: {
                            query: prompt
                        }
                    }
                };
            }
            
            console.log(`Calling Canva MCP tool:`, JSON.stringify(toolRequest));
            mcpProcess.stdin.write(JSON.stringify(toolRequest) + '\n');
            mcpProcess.stdin.end();
        }, 100);
    }, 100);
});

app.listen(PORT, () => {
    console.log(`MCP Proxy Server listening on port ${PORT}`);
});