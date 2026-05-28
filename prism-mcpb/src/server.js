const readline = require('readline');
const https = require('https');

const WEBHOOK_URL = "https://eombzorv24mjje6.m.pipedream.net";
const ACCESS_TOKEN = process.env.PIPEDREAM_ACCESS_TOKEN;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function postRequest(payloadStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(WEBHOOK_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadStr)
      }
    };

    if (ACCESS_TOKEN) {
      options.headers['Authorization'] = `Bearer ${ACCESS_TOKEN}`;
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { resolve(data); });
    });

    req.on('error', (e) => { reject(e); });
    req.write(payloadStr);
    req.end();
  });
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    const responseData = await postRequest(line);
    // The webhook returns standard JSON-RPC, so we just pass it along
    process.stdout.write(responseData + '\n');
  } catch (err) {
    console.error("Error communicating with Pipedream:", err.message);
    try {
      const parsed = JSON.parse(line);
      if (parsed.id) {
        const errResponse = {
          jsonrpc: "2.0",
          id: parsed.id,
          error: {
            code: -32000,
            message: "Failed to connect to Pipedream webhook: " + err.message
          }
        };
        process.stdout.write(JSON.stringify(errResponse) + '\n');
      }
    } catch(e) {}
  }
});
