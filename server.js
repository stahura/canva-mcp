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

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Canva MCP Proxy Server is running' });
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
    // This is the command from the Canva docs to run the server
    const mcpProcess = spawn('npx', ['-y', '@canva/cli@latest', 'mcp'], {
        env: { ...process.env, NODE_ENV: 'production' }
    });

    let responseData = '';
    let errorData = '';

    // Listen for data coming out of the MCP process
    mcpProcess.stdout.on('data', (data) => {
        responseData += data.toString();
        console.log(`MCP stdout: ${data}`);
    });

    // Listen for any errors
    mcpProcess.stderr.on('data', (data) => {
        errorData += data.toString();
        console.error(`MCP stderr: ${data}`);
    });

    // Set a timeout for the MCP process
    const timeout = setTimeout(() => {
        console.log('MCP process timeout, killing process');
        mcpProcess.kill();
        if (!res.headersSent) {
            res.status(408).json({ 
                error: 'MCP process timeout',
                details: 'Process took too long to respond',
                partialResponse: responseData,
                partialError: errorData
            });
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

    // Send the prompt to the MCP process's standard input
    console.log(`Writing prompt to MCP stdin: ${prompt}`);
    mcpProcess.stdin.write(prompt + '\n');
    mcpProcess.stdin.end(); // Close the input stream to signal we're done
});

app.listen(PORT, () => {
    console.log(`MCP Proxy Server listening on port ${PORT}`);
});