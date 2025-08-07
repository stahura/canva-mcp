const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

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

// Function to handle OAuth flow with headless browser
async function handleOAuthWithBrowser(authUrl) {
    let browser = null;
    try {
        console.log('Starting headless browser for OAuth flow...');
        
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        });
        
        const page = await browser.newPage();
        
        // Set user agent to avoid bot detection
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        console.log(`Navigating to OAuth URL: ${authUrl}`);
        
        // Navigate to the OAuth authorization URL
        await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Wait for the page to load and look for authorization elements
        await page.waitForTimeout(2000);
        
        // Debug: Log page title and URL
        const pageTitle = await page.title();
        const initialUrl = page.url();
        console.log(`Page loaded - Title: "${pageTitle}", URL: ${initialUrl}`);
        
        // Debug: Log all buttons on the page
        try {
            const buttonInfo = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.map((button, index) => ({
                    index,
                    text: (button.textContent || button.innerText || '').trim(),
                    classes: button.className,
                    type: button.type,
                    id: button.id
                }));
            });
            console.log('Found buttons on page:', JSON.stringify(buttonInfo, null, 2));
        } catch (e) {
            console.log('Could not enumerate buttons:', e.message);
        }
        
        // Look for Canva-specific OAuth authorization buttons
        let authButton = null;
        
        // Try Canva-specific class combination first
        try {
            const canvaButton = await page.$('button._5KATa.LQzFZw.VgvqKQ._8ERLTg');
            if (canvaButton) {
                console.log('Found Canva-specific authorization button');
                authButton = canvaButton;
            }
        } catch (e) {
            console.log('Canva-specific selector failed, trying alternatives...');
        }
        
        // If that didn't work, search for buttons containing "Allow" text
        if (!authButton) {
            try {
                authButton = await page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    return buttons.find(button => {
                        const text = button.textContent || button.innerText || '';
                        return text.toLowerCase().includes('allow') || 
                               text.toLowerCase().includes('authorize') || 
                               text.toLowerCase().includes('accept');
                    });
                });
                
                if (authButton && await authButton.asElement()) {
                    console.log('Found authorization button by text content');
                    authButton = await authButton.asElement();
                } else {
                    authButton = null;
                }
            } catch (e) {
                console.log('Text-based search failed:', e.message);
                authButton = null;
            }
        }
        
        // Final fallback: try common selectors
        if (!authButton) {
            const fallbackSelectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                '[data-testid="authorize"]',
                '.auth-button',
                '.authorize-button'
            ];
            
            for (const selector of fallbackSelectors) {
                try {
                    authButton = await page.$(selector);
                    if (authButton) {
                        console.log(`Found authorization button with fallback selector: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Continue to next selector
                }
            }
        }
        
        if (authButton) {
            console.log('Clicking authorization button...');
            await authButton.click();
            
            // Wait for redirect and capture the callback URL
            await page.waitForTimeout(3000);
            
            // Check if we got redirected to a callback URL
            const currentUrl = page.url();
            console.log(`Current URL after authorization: ${currentUrl}`);
            
            // Look for callback URL with authorization code
            if (currentUrl.includes('code=')) {
                console.log('Authorization successful! Callback URL captured.');
                return { success: true, callbackUrl: currentUrl };
            }
        }
        
        // If we get here, try to extract any callback URL from the page
        const currentUrl = page.url();
        if (currentUrl.includes('code=')) {
            return { success: true, callbackUrl: currentUrl };
        }
        
        // Take a screenshot for debugging
        const screenshot = await page.screenshot({ encoding: 'base64' });
        console.log('OAuth flow did not complete as expected');
        
        return { 
            success: false, 
            error: 'Could not complete OAuth authorization automatically',
            currentUrl: currentUrl,
            screenshot: `data:image/png;base64,${screenshot}`
        };
        
    } catch (error) {
        console.error('Error in headless browser OAuth flow:', error);
        return { 
            success: false, 
            error: error.message,
            details: 'Headless browser automation failed'
        };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

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
        OAUTH_REDIRECT_URI: `${baseUrl}/oauth/callback`,
        // Disable interactive authentication
        CI: 'true',
        NO_BROWSER: 'true',
        HEADLESS: 'true'
    };
    
    console.log('Environment variables set:', Object.keys(mcpEnv).filter(k => k.startsWith('CANVA') || ['CI', 'NO_BROWSER', 'HEADLESS'].includes(k)));
    
    const mcpProcess = spawn('npx', ['-y', 'mcp-remote@latest', 'https://mcp.canva.com/mcp'], {
        env: mcpEnv
    });

    let responseData = '';
    let errorData = '';

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
            
            // Replace localhost redirect URI with our Railway server URL
            const baseUrl = req.get('host') ? `https://${req.get('host')}` : 'http://localhost:3000';
            const railwayCallbackUrl = encodeURIComponent(`${baseUrl}/oauth/callback`);
            
            console.log(`Base URL: ${baseUrl}`);
            console.log(`Railway callback URL: ${railwayCallbackUrl}`);
            console.log(`Original OAuth URL: ${authUrl}`);
            
            // More robust URL replacement - try multiple patterns
            const originalUrl = authUrl;
            authUrl = authUrl.replace(/redirect_uri=([^&]+)/, `redirect_uri=${railwayCallbackUrl}`);
            
            // If that didn't work, try URL decoding first
            if (authUrl === originalUrl) {
                const decodedUrl = decodeURIComponent(authUrl);
                console.log(`Trying with decoded URL: ${decodedUrl}`);
                authUrl = decodedUrl.replace(/redirect_uri=([^&]+)/, `redirect_uri=${railwayCallbackUrl}`);
                authUrl = encodeURI(authUrl);
            }
            
            // If still not working, do a more aggressive replacement
            if (authUrl === originalUrl || authUrl.includes('localhost')) {
                console.log('Doing aggressive localhost replacement...');
                authUrl = authUrl.replace(/http%3A%2F%2Flocalhost%3A\d+%2Foauth%2Fcallback/, railwayCallbackUrl);
                authUrl = authUrl.replace(/http:\/\/localhost:\d+\/oauth\/callback/, `${baseUrl}/oauth/callback`);
            }
            
            console.log(`Final modified OAuth URL: ${authUrl}`);
            
            // Clear the timeout and handle OAuth with headless browser
            clearTimeout(timeout);
            
            if (!res.headersSent) {
                console.log('Starting automated OAuth flow with headless browser...');
                
                // Return immediate response indicating automation is in progress
                res.status(200).json({
                    automating: true,
                    message: 'Automating OAuth flow with headless browser...',
                    instructions: 'Please wait while we automatically handle the authorization process.',
                    authUrl: authUrl
                });
                
                // Handle OAuth automation asynchronously
                handleOAuthWithBrowser(authUrl).then(result => {
                    if (result.success) {
                        console.log('Headless browser OAuth completed successfully!');
                        // Extract the authorization code from the callback URL
                        try {
                            const callbackUrl = new URL(result.callbackUrl);
                            const code = callbackUrl.searchParams.get('code');
                            const state = callbackUrl.searchParams.get('state');
                            
                            if (code) {
                                global.oauthCode = code;
                                global.oauthState = state;
                                console.log(`OAuth code stored: ${code}`);
                            }
                        } catch (e) {
                            console.error('Error parsing callback URL from browser:', e);
                        }
                    } else {
                        console.error('Headless browser OAuth failed:', result.error);
                    }
                }).catch(error => {
                    console.error('Headless browser OAuth error:', error);
                });
            }
        }
    });

    // Set a timeout for the MCP process
    const timeout = setTimeout(() => {
        console.log('MCP process timeout, killing process');
        mcpProcess.kill();
        if (!res.headersSent) {
            // Check if this is an OAuth authentication issue
            if (errorData.includes('Please authorize') || errorData.includes('Authentication required')) {
                res.status(401).json({ 
                    error: 'OAuth Authentication Required',
                    details: 'The Canva MCP server requires OAuth authentication. Please set up authentication tokens in Railway environment variables.',
                    authUrl: 'https://mcp.canva.com/authorize',
                    instructions: 'This server needs to be authenticated with Canva. In a production environment, you would need to implement OAuth flow or provide pre-authenticated tokens.',
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
    }, 30000); // 30 second timeout

    // When the process closes, send the response back to your client
    mcpProcess.on('close', (code) => {
        clearTimeout(timeout);
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
                        details: 'The Canva MCP server requires OAuth authentication. This cannot be completed automatically in a serverless environment.',
                        authUrl: 'https://mcp.canva.com/authorize',
                        instructions: 'To use this server, you need to:\n1. Authenticate locally with the Canva MCP server\n2. Extract OAuth tokens\n3. Add them as Railway environment variables',
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
        clearTimeout(timeout);
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