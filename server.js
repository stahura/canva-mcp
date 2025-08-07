const express = require('express');
const { spawn } = require('child_process');

const app = express();
app.use(express.json()); // Middleware to parse JSON bodies

const PORT = process.env.PORT || 3000;

// This is the API endpoint your client will hit
app.post('/api/mcp', (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    console.log("Starting Canva MCP process...");
    // This is the command from the Canva docs to run the server
    const mcpProcess = spawn('npx', ['-y', '@canva/cli@latest', 'mcp']);

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

    // When the process closes, send the response back to your client
    mcpProcess.on('close', (code) => {
        console.log(`MCP process exited with code ${code}`);
        if (code !== 0 || errorData) {
            return res.status(500).json({ 
                error: 'MCP process failed.', 
                details: errorData 
            });
        }
        res.json({ response: responseData });
    });

    // Send the prompt to the MCP process's standard input
    console.log(`Writing prompt to MCP stdin: ${prompt}`);
    mcpProcess.stdin.write(prompt);
    mcpProcess.stdin.end(); // Close the input stream to signal we're done
});

app.listen(PORT, () => {
    console.log(`MCP Proxy Server listening on port ${PORT}`);
});