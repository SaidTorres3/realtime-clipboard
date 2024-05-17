const express = require('express');
const multer = require('multer');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const minimist = require('minimist');
const os = require('os');
const bodyParser = require('body-parser');
const sanitizeFilename = require('sanitize-filename');

// Parse command-line arguments
const args = minimist(process.argv.slice(2));
const host = args.a || '0.0.0.0';
const port = args.p || 8088;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Setup storage for multer with sanitized filename
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const originalName = sanitizeFilename(file.originalname.replace(/\.[^.]+$/, '')); // Sanitize filename
    const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
    cb(null, `${originalName}-${randomSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ storage });

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use('/uploads', express.static(uploadsDir));
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.text());

let sharedText = '';

const readSharedTextFromFile = () => {
  try {
    sharedText = fs.readFileSync('sharedText.txt', 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      fs.writeFileSync('sharedText.txt', '', 'utf8');
      sharedText = '';
    } else {
      console.error('Error reading sharedText file:', err);
      sharedText = '';
    }
  }
};

const writeSharedTextToFile = (text) => {
  fs.writeFileSync('sharedText.txt', text, 'utf8');
};

readSharedTextFromFile();

app.get('/', (req, res) => {
  const userAgent = req.headers['user-agent'] || '';
  if (userAgent.includes('curl') || userAgent.includes('wget') || req.query.textonly) {
    res.send(sharedText + '\n');
  } else {
    fs.readdir(uploadsDir, (err, files) => {
      res.render('index', { files });
    });
  }
});

app.put('/', (req, res) => {
  const [key, newText] = Object.entries(req.body)[0];

  if (typeof key === 'string') {
    sharedText = key;
    writeSharedTextToFile(key);
    io.emit('textUpdate', key);
    res.status(200).send('Text updated successfully' + '\n');
  } else {
    res.status(400).send('Invalid input' + '\n');
  }
});

app.get('/files', (req, res) => {
  fs.readdir(uploadsDir, (err, files) => {
    if (req.query.json) {
      res.json(files);
    } else {
      res.send(files.join('\n') + '\n');
    }
  });
});

app.get('/files/:filename', (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  const filepath = path.join(uploadsDir, filename);

  fs.access(filepath, fs.constants.F_OK, (err) => {
    if (err) {
      return res.status(404).send('File not found' + '\n');
    }

    res.download(filepath, (err) => {
      if (err) {
        console.error('Error downloading the file:', err);
        if (!res.headersSent) {
          res.status(500).send('Error downloading the file' + '\n');
        }
      }
    });
  });
});

app.post('/upload', upload.array('files', 10), (req, res) => {
  io.emit('fileUpdate');
  res.redirect('/');
});

app.delete('/files/:filename', (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  const filePath = path.join(uploadsDir, filename);

  fs.unlink(filePath, (err) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // File doesn't exist
        console.warn(`File not found: ${filePath}`);
        res.status(404).send('File not found' + '\n');
      } else {
        // Other errors
        console.error('Error deleting the file:', err);
        res.status(500).send('Error deleting the file' + '\n');
      }
    } else {
      io.emit('fileUpdate');
      res.status(200).send('File deleted successfully' + '\n');
    }
  });
});

io.on('connection', (socket) => {
  socket.emit('textUpdate', sharedText);

  socket.on('textChange', (text) => {
    sharedText = text;
    writeSharedTextToFile(text);
    socket.broadcast.emit('textUpdate', text);
  });

  socket.on('fileUpdate', () => {
    fs.readdir(uploadsDir, (err, files) => {
      io.emit('fileList', files);
    });
  });
});

const getLocalIPAddress = () => {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const { family, address, internal } of iface) {
      if (family === 'IPv4' && !internal) {
        return address;
      }
    }
  }
  return 'localhost';
};

server.listen(port, host, () => {
  console.log(`Server is running on http://${host}:${port}`);
  if (host === '0.0.0.0') {
    const localIP = getLocalIPAddress();
    console.log(`Access it using http://${localIP}:${port}`);
  }
});
