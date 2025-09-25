import express from 'express';
import multer from 'multer';
import http from 'http';
import { Server as SocketIoServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import minimist from 'minimist';
import os from 'os';
import bodyParser from 'body-parser';
import sanitizeFilename from 'sanitize-filename';
import { v4 as uuidv4 } from 'uuid';
import Busboy from 'busboy';

// Fix __dirname and __filename in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command-line arguments
const args = minimist(process.argv.slice(2));
const host = args.a || process.env.HOST || '0.0.0.0';
const port = args.p || process.env.PORT || 8088;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Create temporary directory for chunked uploads
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Clean up any orphaned temp files from previous runs
function cleanupOrphanedTempFiles() {
  try {
    const tempFiles = fs.readdirSync(tempDir);
    let cleanedCount = 0;
    
    tempFiles.forEach(file => {
      const filePath = path.join(tempDir, file);
      try {
        fs.unlinkSync(filePath);
        cleanedCount++;
      } catch (error) {
        console.error(`Error cleaning up temp file ${file}:`, error.message);
      }
    });
    
    if (cleanedCount > 0) {
      console.log(`Cleaned up ${cleanedCount} orphaned temp files from previous run`);
    }
  } catch (error) {
    console.error('Error during temp file cleanup:', error.message);
  }
}

// Clean up orphaned files on startup
cleanupOrphanedTempFiles();

// Store active upload sessions
const uploadSessions = new Map();

const removeAccents = (str) => {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9-]/g, '_');
};

// Setup storage for multer with sanitized filename
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    let originalName = file.originalname.replace(/\.[^.]+$/, ''); // Remove file extension
    originalName = removeAccents(originalName); // Remove accents and special characters
    originalName = sanitizeFilename(originalName); // Sanitize the filename
    const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
    cb(null, `${originalName}-${randomSuffix}${path.extname(file.originalname)}`);
  }
});

const app = express();
const server = http.createServer(app);
const io = new SocketIoServer(server);

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use('/uploads', express.static(uploadsDir));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Add JSON parser for chunked upload endpoints
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

app.use(express.static(__dirname + '/views'));

app.get('/', (req, res) => {
  const userAgent = req.headers['user-agent'] || '';
  if (userAgent.includes('curl') || userAgent.includes('wget') || userAgent.includes('PowerShell') || req.query.textonly) {
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

const upload = multer({ storage }).any();

// Chunked upload endpoints
app.post('/upload/initiate', (req, res) => {
  console.log('Upload initiate request:', req.body);
  const { fileName, fileSize, totalChunks } = req.body;
  
  if (!fileName || !fileSize || !totalChunks) {
    console.log('Missing parameters:', { fileName, fileSize, totalChunks });
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const uploadId = uuidv4();
  const sanitizedFileName = sanitizeFilename(fileName);
  const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
  const finalFileName = `${sanitizedFileName.replace(/\.[^.]+$/, '')}-${randomSuffix}${path.extname(sanitizedFileName)}`;
  
  uploadSessions.set(uploadId, {
    fileName: finalFileName,
    originalFileName: fileName,
    fileSize: parseInt(fileSize),
    totalChunks: parseInt(totalChunks),
    uploadedChunks: 0,
    chunks: new Map(),
    createdAt: new Date()
  });

  res.json({ uploadId, fileName: finalFileName });
});

app.post('/upload/chunk', (req, res) => {
  const busboy = Busboy({ headers: req.headers });
  let uploadId, chunkIndex, chunk;

  busboy.on('field', (fieldname, val) => {
    if (fieldname === 'uploadId') uploadId = val;
    if (fieldname === 'chunkIndex') chunkIndex = parseInt(val);
  });

  busboy.on('file', (fieldname, file, info) => {
    const chunks = [];
    file.on('data', (data) => {
      chunks.push(data);
    });
    file.on('end', () => {
      chunk = Buffer.concat(chunks);
    });
  });

  busboy.on('finish', () => {
    if (!uploadId || chunkIndex === undefined || !chunk) {
      return res.status(400).json({ error: 'Missing chunk data' });
    }

    const session = uploadSessions.get(uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    // Store chunk in temporary directory
    const chunkPath = path.join(tempDir, `${uploadId}_chunk_${chunkIndex}`);
    fs.writeFileSync(chunkPath, chunk);
    
    session.chunks.set(chunkIndex, chunkPath);
    session.uploadedChunks++;
    session.lastActivity = new Date(); // Track activity for stale session detection

    res.json({ 
      success: true, 
      uploadedChunks: session.uploadedChunks,
      totalChunks: session.totalChunks
    });
  });

  busboy.on('error', (err) => {
    console.error('Busboy error:', err);
    res.status(500).json({ error: 'Upload error' });
  });

  req.pipe(busboy);
});

app.post('/upload/complete', (req, res) => {
  const { uploadId } = req.body;
  
  if (!uploadId) {
    return res.status(400).json({ error: 'Missing uploadId' });
  }

  const session = uploadSessions.get(uploadId);
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found' });
  }

  if (session.uploadedChunks !== session.totalChunks) {
    return res.status(400).json({ 
      error: 'Incomplete upload',
      uploaded: session.uploadedChunks,
      total: session.totalChunks
    });
  }

  try {
    // Combine all chunks into final file
    const finalPath = path.join(uploadsDir, session.fileName);
    const chunks = [];

    // Read all chunks first
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = session.chunks.get(i);
      if (!chunkPath || !fs.existsSync(chunkPath)) {
        throw new Error(`Missing chunk ${i}`);
      }
      
      const chunkData = fs.readFileSync(chunkPath);
      chunks.push(chunkData);
    }

    // Combine all chunks and write to final file
    const combinedData = Buffer.concat(chunks);
    fs.writeFileSync(finalPath, combinedData);

    // Clean up chunk files after successful write
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = session.chunks.get(i);
      if (chunkPath && fs.existsSync(chunkPath)) {
        fs.unlinkSync(chunkPath);
      }
    }
    
    // Clean up session
    uploadSessions.delete(uploadId);
    
    io.emit('fileUpdate');
    res.json({ success: true, fileName: session.fileName });
    
  } catch (error) {
    console.error('Error combining chunks:', error);
    
    // Clean up failed upload
    session.chunks.forEach(chunkPath => {
      if (fs.existsSync(chunkPath)) {
        fs.unlinkSync(chunkPath);
      }
    });
    uploadSessions.delete(uploadId);
    
    res.status(500).json({ error: 'Failed to combine file chunks' });
  }
});

app.get('/upload/status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const session = uploadSessions.get(uploadId);
  
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found' });
  }

  res.json({
    fileName: session.originalFileName,
    uploadedChunks: session.uploadedChunks,
    totalChunks: session.totalChunks,
    progress: (session.uploadedChunks / session.totalChunks) * 100
  });
});

app.delete('/upload/cancel/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const session = uploadSessions.get(uploadId);
  
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found' });
  }

  console.log(`Canceling upload session: ${uploadId} for file: ${session.originalFileName}`);
  
  // Mark session for delayed cleanup (30 seconds)
  session.canceledAt = new Date();
  session.status = 'canceled';
  
  res.json({ success: true, message: 'Upload session marked for cancellation' });
});

// Manual cleanup endpoint for debugging
app.post('/upload/cleanup', (req, res) => {
  console.log('Manual cleanup triggered');
  
  const beforeCount = uploadSessions.size;
  
  // Get temp files count before cleanup
  let tempFilesBefore = 0;
  try {
    tempFilesBefore = fs.readdirSync(tempDir).length;
  } catch (error) {
    console.error('Error reading temp directory:', error);
  }
  
  // Run cleanup
  cleanupUploadSessions();
  
  const afterCount = uploadSessions.size;
  
  // Get temp files count after cleanup
  let tempFilesAfter = 0;
  try {
    tempFilesAfter = fs.readdirSync(tempDir).length;
  } catch (error) {
    console.error('Error reading temp directory:', error);
  }
  
  const result = {
    sessionsCleanedUp: beforeCount - afterCount,
    activeSessions: afterCount,
    tempFilesCleanedUp: tempFilesBefore - tempFilesAfter,
    remainingTempFiles: tempFilesAfter
  };
  
  console.log('Manual cleanup result:', result);
  res.json(result);
});

app.post('/upload', (req, res) => {
  const userAgent = req.headers['user-agent'] || '';

  upload(req, res, (err) => {
    if (err) {
      return res.status(500).send('Error uploading file(s): ' + err.message + '\n');
    }

    if (req.files.length === 0) {
      return res.status(400).send('No files uploaded' + '\n');
    }

    if (req.files.length === 1) {
      io.emit('fileUpdate');
      if (req.headers['user-agent'] && (req.headers['user-agent'].includes('curl')) || userAgent.includes('wget')) {
        return res.status(200).send('Single file uploaded successfully' + '\n');
      } else {
        return res.redirect('/');
      }
    } else {
      io.emit('fileUpdate');
      if (req.headers['user-agent'] && (req.headers['user-agent'].includes('curl') || userAgent.includes('wget'))) {
        return res.status(200).send('Multiple files uploaded successfully' + '\n');
      } else {
        return res.redirect('/');
      }
    }
  });
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

// Enhanced cleanup for expired and canceled upload sessions
function cleanupUploadSessions() {
  const now = new Date();
  const toCleanup = [];
  
  uploadSessions.forEach((session, uploadId) => {
    const age = now - session.createdAt;
    const maxAge = 30 * 60 * 1000; // 30 minutes
    
    let shouldCleanup = false;
    let reason = '';
    
    // Check if session is expired
    if (age > maxAge) {
      shouldCleanup = true;
      reason = 'expired';
    }
    
    // Check if session was canceled and enough time has passed
    if (session.status === 'canceled' && session.canceledAt) {
      shouldCleanup = true;
      reason = 'canceled';
    }
    
    // Check for stale sessions (no activity for 2 minutes) - much more aggressive
    const lastActivity = session.lastActivity || session.createdAt;
    const timeSinceActivity = now - lastActivity;
    const staleThreshold = 2 * 60 * 1000; // 2 minutes instead of 10
    
    if (timeSinceActivity > staleThreshold && session.status !== 'canceled') {
      shouldCleanup = true;
      reason = 'stale';
    }
    
    if (shouldCleanup) {
      toCleanup.push({ uploadId, session, reason });
    }
  });
  
  // Also clean up orphaned chunk files that don't belong to any active session
  cleanupOrphanedChunks();
  
  // Perform cleanup
  toCleanup.forEach(({ uploadId, session, reason }) => {
    console.log(`Cleaning up ${reason} upload session: ${uploadId} (${session.originalFileName})`);
    
    // Clean up chunk files
    let cleanedChunks = 0;
    session.chunks.forEach(chunkPath => {
      try {
        if (fs.existsSync(chunkPath)) {
          fs.unlinkSync(chunkPath);
          cleanedChunks++;
        }
      } catch (error) {
        console.error(`Error deleting chunk file ${chunkPath}:`, error.message);
      }
    });
    
    if (cleanedChunks > 0) {
      console.log(`  → Cleaned up ${cleanedChunks} chunk files`);
    }
    
    uploadSessions.delete(uploadId);
  });
  
  if (toCleanup.length > 0) {
    console.log(`Cleanup completed: ${toCleanup.length} sessions processed`);
  }
}

// Function to clean up orphaned chunks that don't belong to any active session
function cleanupOrphanedChunks() {
  try {
    const tempFiles = fs.readdirSync(tempDir);
    const activeUploadIds = new Set(Array.from(uploadSessions.keys()));
    let orphanedCount = 0;
    
    tempFiles.forEach(file => {
      // Extract uploadId from chunk filename (format: uploadId_chunk_index)
      const uploadIdMatch = file.match(/^([^_]+)_chunk_\d+$/);
      
      if (uploadIdMatch) {
        const uploadId = uploadIdMatch[1];
        
        // If this chunk doesn't belong to any active session, it's orphaned
        if (!activeUploadIds.has(uploadId)) {
          const filePath = path.join(tempDir, file);
          try {
            fs.unlinkSync(filePath);
            orphanedCount++;
          } catch (error) {
            console.error(`Error deleting orphaned chunk ${file}:`, error.message);
          }
        }
      }
    });
    
    if (orphanedCount > 0) {
      console.log(`Cleaned up ${orphanedCount} orphaned chunk files`);
    }
  } catch (error) {
    console.error('Error during orphaned chunk cleanup:', error.message);
  }
}

// Run cleanup every 10 seconds for better responsiveness
setInterval(cleanupUploadSessions, 10 * 1000);

// Also run cleanup immediately to handle current orphaned files
setTimeout(cleanupUploadSessions, 1000);

server.listen(port, host, () => {
  console.log(`Server is running on http://${host}:${port}`);
  if (host === '0.0.0.0') {
    const localIP = getLocalIPAddress();
    console.log(`Access it using http://${localIP}:${port}`);
  }
});

export default app; // Export the app for testing
