const express = require('express');
const multer = require('multer');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const minimist = require('minimist');

// Parse command-line arguments
const args = minimist(process.argv.slice(2));
const host = args.a || '0.0.0.0';
const port = args.p || 8088;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Setup storage for multer with original filename
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const originalName = file.originalname.replace(/\.[^.]+$/, ''); // Remove file extension
    const randomSuffix = Date.now();
    cb(null, `${originalName}-${randomSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ storage });

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));

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
    fs.readdir('uploads/', (err, files) => {
      res.render('index', { files });
    });
  }
});

app.get('/files', (req, res) => {
  fs.readdir('uploads/', (err, files) => {
    if (req.query.json) {
      res.json(files);
    } else {
      res.send(files.join('\n') + '\n');
    }
  });
});

app.get('/files/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(__dirname, 'uploads', filename);

  fs.access(filepath, fs.constants.F_OK, (err) => {
    if (err) {
      return res.status(404).send('File not found');
    }

    res.download(filepath, (err) => {
      if (err) {
        console.error('Error downloading the file:', err);
        if (!res.headersSent) {
          res.status(500).send('Error downloading the file');
        }
      }
    });
  });
});

app.post('/upload', upload.single('file'), (req, res) => {
  io.emit('fileUpdate');
  res.redirect('/');
});

app.post('/delete', (req, res) => {
  const { filename } = req.body;
  fs.unlink(path.join(__dirname, 'uploads', filename), (err) => {
    if (err) throw err;
    io.emit('fileUpdate');
    res.redirect('/');
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
    fs.readdir('uploads/', (err, files) => {
      io.emit('fileList', files);
    });
  });
});

server.listen(port, host, () => {
  console.log(`Server is running on http://${host}:${port}`);
  if (host === '0.0.0.0') {
    console.log(`Access it using http://localhost:${port}`);
  }
});