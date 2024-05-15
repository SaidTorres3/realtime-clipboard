const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const port = 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// In-memory storage for the text and timestamp
let sharedText = '';
let lastUpdate = Date.now();

// Serve the HTML page
app.get('/', (req, res) => {
  res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Text Share</title>
        </head>
        <body>
            <textarea id="sharedText" style="width: 100%; height: 98vh;">${sharedText}</textarea>
            <script>
                const textarea = document.getElementById('sharedText');
                let typing = false;
                let lastTypedTime = Date.now();
                let lastFetchedTime = ${lastUpdate};

                const debounce = (func, delay) => {
                    let debounceTimer;
                    return (...args) => {
                        clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(() => func(...args), delay);
                    };
                };

                const fetchText = async () => {
                    const response = await fetch('/get');
                    const data = await response.json();
                    if (data.timestamp > lastFetchedTime && !typing) {
                        textarea.value = data.text;
                        lastFetchedTime = data.timestamp;
                    }
                };

                const updateText = debounce(async () => {
                    const response = await fetch('/update', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: textarea.value, timestamp: Date.now() })
                    });
                    if (response.ok) {
                        lastFetchedTime = Date.now();
                    }
                }, 300);

                textarea.addEventListener('input', () => {
                    typing = true;
                    lastTypedTime = Date.now();
                    updateText();
                });

                setInterval(() => {
                    const currentTime = Date.now();
                    if (currentTime - lastTypedTime > 100) {
                        typing = false;
                    }
                    fetchText();
                }, 1000);
            </script>
        </body>
        </html>
    `);
});

// Endpoint to update the shared text
app.post('/update', (req, res) => {
  sharedText = req.body.text;
  lastUpdate = req.body.timestamp;
  res.sendStatus(200);
});

// Endpoint to get the shared text
app.get('/get', (req, res) => {
  res.json({ text: sharedText, timestamp: lastUpdate });
});

app.listen(port, () => {
  console.log(`Text share app listening at http://0.0.0.0:${port}`);
});
