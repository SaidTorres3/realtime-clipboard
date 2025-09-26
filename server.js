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

// Create shared text directory
const sharedTextDir = path.join(__dirname, 'sharedText');
if (!fs.existsSync(sharedTextDir)) {
  fs.mkdirSync(sharedTextDir);
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

// Helper functions for environment management
const getEnvironmentName = (req) => {
  let routePath = req.path.slice(1); // Remove leading slash
  
  // Handle upload paths - extract environment from /:environment/upload
  if (routePath.endsWith('/upload')) {
    routePath = routePath.slice(0, -7); // Remove '/upload' suffix
  }
  
  // Handle other endpoint paths like /:environment/files, etc.
  const pathParts = routePath.split('/');
  if (pathParts.length > 1) {
    // Take the first part as the environment name
    routePath = pathParts[0];
  }
  
  return routePath === '' || routePath === 'upload' ? 'default' : sanitizeFilename(routePath) || 'default';
};

// Helper function to check if file is an image
const isImageFile = (filename) => {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif'];
  const ext = path.extname(filename).toLowerCase();
  return imageExtensions.includes(ext);
};

const getEnvironmentUploadsDir = (environmentName, createIfNotExists = false) => {
  const envDir = path.join(uploadsDir, environmentName);
  if (createIfNotExists && !fs.existsSync(envDir)) {
    fs.mkdirSync(envDir, { recursive: true });
  }
  return envDir;
};

const getEnvironmentTextFile = (environmentName) => {
  return path.join(sharedTextDir, `${environmentName}.txt`);
};

// Check if environment has any content (files or non-empty text)
const hasEnvironmentContent = (environmentName) => {
  const envDir = getEnvironmentUploadsDir(environmentName, false);
  const textFile = getEnvironmentTextFile(environmentName);
  
  // Check if upload directory exists and has files
  let hasFiles = false;
  if (fs.existsSync(envDir)) {
    try {
      const files = fs.readdirSync(envDir);
      hasFiles = files.length > 0;
    } catch (err) {
      console.error('Error reading environment directory:', err);
    }
  }
  
  // Check if text file exists and has content
  let hasText = false;
  if (fs.existsSync(textFile)) {
    try {
      const text = fs.readFileSync(textFile, 'utf8');
      hasText = text.trim().length > 0;
    } catch (err) {
      console.error('Error reading text file:', err);
    }
  }
  
  // Also check cached text for environments that might have content in memory but no file yet
  if (!hasText && sharedTextCache.has(environmentName)) {
    const cachedText = sharedTextCache.get(environmentName);
    hasText = cachedText.trim().length > 0;
  }
  
  return hasFiles || hasText;
};

// Clean up empty environment directories and text files
const cleanupEmptyEnvironment = (environmentName) => {
  // Don't clean up the default environment
  if (environmentName === 'default') {
    return;
  }
  
  if (!hasEnvironmentContent(environmentName)) {
    const envDir = getEnvironmentUploadsDir(environmentName, false);
    const textFile = getEnvironmentTextFile(environmentName);
    
    // Remove empty upload directory
    if (fs.existsSync(envDir)) {
      try {
        const files = fs.readdirSync(envDir);
        if (files.length === 0) {
          fs.rmdirSync(envDir);
          console.log(`Cleaned up empty environment directory: ${envDir}`);
        }
      } catch (err) {
        console.error('Error cleaning up environment directory:', err);
      }
    }
    
    // Remove empty text file
    if (fs.existsSync(textFile)) {
      try {
        const text = fs.readFileSync(textFile, 'utf8');
        if (text.trim().length === 0) {
          fs.unlinkSync(textFile);
          console.log(`Cleaned up empty text file: ${textFile}`);
        }
      } catch (err) {
        console.error('Error cleaning up text file:', err);
      }
    }
    
    // Remove from cache if empty
    if (sharedTextCache.has(environmentName)) {
      const cachedText = sharedTextCache.get(environmentName);
      if (cachedText.trim().length === 0) {
        sharedTextCache.delete(environmentName);
      }
    }
  }
};

// Setup storage for multer with sanitized filename and environment separation
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const environmentName = getEnvironmentName(req);
    const envUploadsDir = getEnvironmentUploadsDir(environmentName, true); // Create directory when file is uploaded
    cb(null, envUploadsDir);
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
// Configure static file serving with proper MIME types for images
app.use('/uploads', express.static(uploadsDir, {
  setHeaders: (res, path) => {
    // Set proper MIME types for common image formats
    const ext = path.toLowerCase().split('.').pop();
    const imageMimeTypes = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg', 
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'svg': 'image/svg+xml',
      'bmp': 'image/bmp',
      'ico': 'image/x-icon',
      'tiff': 'image/tiff',
      'tif': 'image/tiff'
    };
    
    if (imageMimeTypes[ext]) {
      res.setHeader('Content-Type', imageMimeTypes[ext]);
      // Add caching headers for images
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year
    }
  }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '50mb' })); // Increased limit for image paste data
app.use(bodyParser.text());

// Store shared text per environment
const sharedTextCache = new Map();

const readSharedTextFromFile = (environmentName) => {
  const textFile = getEnvironmentTextFile(environmentName);
  try {
    const text = fs.readFileSync(textFile, 'utf8');
    sharedTextCache.set(environmentName, text);
    return text;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Don't create empty file, just cache empty string
      sharedTextCache.set(environmentName, '');
      return '';
    } else {
      console.error('Error reading sharedText file:', err);
      sharedTextCache.set(environmentName, '');
      return '';
    }
  }
};

const writeSharedTextToFile = (environmentName, text) => {
  const textFile = getEnvironmentTextFile(environmentName);
  
  // Only create and write file if there's actual content
  if (text.trim().length > 0) {
    // Ensure the sharedText directory exists
    if (!fs.existsSync(sharedTextDir)) {
      fs.mkdirSync(sharedTextDir, { recursive: true });
    }
    fs.writeFileSync(textFile, text, 'utf8');
  } else if (fs.existsSync(textFile)) {
    // If text is empty but file exists, delete it
    try {
      fs.unlinkSync(textFile);
      console.log(`Deleted empty text file: ${textFile}`);
    } catch (err) {
      console.error('Error deleting empty text file:', err);
    }
  }
  
  sharedTextCache.set(environmentName, text);
  
  // Clean up empty environment after text update
  setTimeout(() => cleanupEmptyEnvironment(environmentName), 1000);
};

const getSharedText = (environmentName) => {
  if (!sharedTextCache.has(environmentName)) {
    return readSharedTextFromFile(environmentName);
  }
  return sharedTextCache.get(environmentName);
};

// Initialize default environment
readSharedTextFromFile('default');

app.use(express.static(__dirname + '/views'));

// Dynamic route handler for environments
app.get('/:environment?', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const envUploadsDir = getEnvironmentUploadsDir(sanitizedEnv, false); // Don't create directory just for viewing
  const sharedText = getSharedText(sanitizedEnv);
  
  const userAgent = req.headers['user-agent'] || '';
  if (userAgent.includes('curl') || userAgent.includes('wget') || userAgent.includes('PowerShell') || req.query.textonly) {
    res.send(sharedText + '\n');
  } else {
    // Only try to read directory if it exists
    if (fs.existsSync(envUploadsDir)) {
      fs.readdir(envUploadsDir, (err, files) => {
        if (err) {
          console.error('Error reading environment directory:', err);
          files = [];
        }
        
        // Separate images from other files and get file info
        const fileList = files.map(file => {
          const filePath = path.join(envUploadsDir, file);
          const stats = fs.statSync(filePath);
          return {
            name: file,
            isImage: isImageFile(file),
            size: stats.size,
            modified: stats.mtime
          };
        });
        
        res.render('index', { 
          files: fileList, 
          environmentName: sanitizedEnv,
          environmentPath: req.params.environment ? `/${req.params.environment}` : ''
        });
      });
    } else {
      // Directory doesn't exist, so no files
      res.render('index', { 
        files: [], 
        environmentName: sanitizedEnv,
        environmentPath: req.params.environment ? `/${req.params.environment}` : ''
      });
    }
  }
});

app.put('/:environment?', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const [key, newText] = Object.entries(req.body)[0];

  if (typeof key === 'string') {
    writeSharedTextToFile(sanitizedEnv, key);
    io.to(sanitizedEnv).emit('textUpdate', key);
    res.status(200).send('Text updated successfully' + '\n');
  } else {
    res.status(400).send('Invalid input' + '\n');
  }
});

app.get('/:environment/files', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const envUploadsDir = getEnvironmentUploadsDir(sanitizedEnv, false);
  
  if (fs.existsSync(envUploadsDir)) {
    fs.readdir(envUploadsDir, (err, files) => {
      if (err) {
        console.error('Error reading environment files:', err);
        files = [];
      }
      if (req.query.json) {
        res.json(files);
      } else {
        res.send(files.join('\n') + '\n');
      }
    });
  } else {
    // Directory doesn't exist, return empty list
    if (req.query.json) {
      res.json([]);
    } else {
      res.send('\n');
    }
  }
});

// Keep backward compatibility for root route
app.get('/files', (req, res) => {
  const envUploadsDir = getEnvironmentUploadsDir('default', false);
  if (fs.existsSync(envUploadsDir)) {
    fs.readdir(envUploadsDir, (err, files) => {
      if (err) {
        console.error('Error reading default files:', err);
        files = [];
      }
      if (req.query.json) {
        res.json(files);
      } else {
        res.send(files.join('\n') + '\n');
      }
    });
  } else {
    // Directory doesn't exist, return empty list
    if (req.query.json) {
      res.json([]);
    } else {
      res.send('\n');
    }
  }
});

app.get('/:environment/files/:filename', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const filename = sanitizeFilename(req.params.filename);
  const envUploadsDir = getEnvironmentUploadsDir(sanitizedEnv);
  const filepath = path.join(envUploadsDir, filename);

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

// Keep backward compatibility for root route
app.get('/files/:filename', (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  const envUploadsDir = getEnvironmentUploadsDir('default');
  const filepath = path.join(envUploadsDir, filename);

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

// Chunked upload endpoints with environment support
app.post('/:environment/upload/initiate', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  
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
    createdAt: new Date(),
    environmentName: sanitizedEnv
  });

  res.json({ uploadId, fileName: finalFileName });
});

// Backward compatibility for root route
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
    createdAt: new Date(),
    environmentName: 'default'
  });

  res.json({ uploadId, fileName: finalFileName });
});

app.post('/:environment/upload/chunk', (req, res) => {
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

// Backward compatibility for chunk upload
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

app.post('/:environment/upload/complete', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
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
    // Combine all chunks into final file in the correct environment directory
    const envUploadsDir = getEnvironmentUploadsDir(session.environmentName || sanitizedEnv, true); // Create directory when completing upload
    const finalPath = path.join(envUploadsDir, session.fileName);
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
    
    // Emit to both the environment room and broadcast to all (for better compatibility)
    io.to(session.environmentName || sanitizedEnv).emit('fileUpdate');
    io.emit('fileUpdate'); // Broadcast to all for better compatibility
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

// Backward compatibility for root route
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
    // Combine all chunks into final file in the default environment
    const envUploadsDir = getEnvironmentUploadsDir(session.environmentName || 'default', true); // Create directory when completing upload
    const finalPath = path.join(envUploadsDir, session.fileName);
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
    
    // Emit to both the environment room and broadcast to all (for better compatibility)
    io.to(session.environmentName || 'default').emit('fileUpdate');
    io.emit('fileUpdate'); // Broadcast to all for better compatibility
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

app.get('/:environment/upload/status/:uploadId', (req, res) => {
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

// Backward compatibility for upload status
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

app.delete('/:environment/upload/cancel/:uploadId', (req, res) => {
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

// Backward compatibility for upload cancel
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

// Manual cleanup endpoint for debugging with environment support
app.post('/:environment/upload/cleanup', (req, res) => {
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

// Backward compatibility for cleanup
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

// Backward compatibility for paste-image endpoint (root level)
app.post('/paste-image', (req, res) => {
  console.log('Paste image request received:', {
    hasBody: !!req.body,
    hasImageData: !!(req.body && req.body.imageData),
    contentType: req.headers['content-type'],
    bodySize: req.body ? JSON.stringify(req.body).length : 0
  });

  if (!req.body || !req.body.imageData) {
    console.error('No image data provided in request');
    return res.status(400).json({ error: 'No image data provided' });
  }
  
  try {
    // Parse base64 image data (format: data:image/png;base64,...)
    const matches = req.body.imageData.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
    if (!matches) {
      console.error('Invalid image data format');
      return res.status(400).json({ error: 'Invalid image data format' });
    }
    
    const imageType = matches[1];
    const imageBuffer = Buffer.from(matches[2], 'base64');
    
    console.log(`Processing ${imageType} image, size: ${imageBuffer.length} bytes`);
    
    // Generate filename for pasted image
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
    const filename = `pasted-image-${timestamp}-${randomSuffix}.${imageType}`;
    
    // Save image to default environment directory
    const envUploadsDir = getEnvironmentUploadsDir('default', true);
    const filePath = path.join(envUploadsDir, filename);
    
    fs.writeFileSync(filePath, imageBuffer);
    console.log(`Image saved successfully as: ${filename}`);
    
    // Emit file update to all clients
    io.to('default').emit('fileUpdate');
    io.emit('fileUpdate'); // Broadcast to all for better compatibility
    
    res.json({ 
      success: true, 
      filename: filename,
      message: 'Image pasted successfully' 
    });
    
  } catch (error) {
    console.error('Error handling pasted image:', error);
    res.status(500).json({ error: 'Failed to process pasted image: ' + error.message });
  }
});

// New endpoint to handle clipboard image paste for environments
app.post('/:environment/paste-image', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  
  console.log('Environment paste image request received:', {
    environment: sanitizedEnv,
    hasBody: !!req.body,
    hasImageData: !!(req.body && req.body.imageData),
    contentType: req.headers['content-type']
  });
  
  if (!req.body || !req.body.imageData) {
    return res.status(400).json({ error: 'No image data provided' });
  }
  
  try {
    // Parse base64 image data (format: data:image/png;base64,...)
    const matches = req.body.imageData.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Invalid image data format' });
    }
    
    const imageType = matches[1];
    const imageBuffer = Buffer.from(matches[2], 'base64');
    
    // Generate filename for pasted image
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
    const filename = `pasted-image-${timestamp}-${randomSuffix}.${imageType}`;
    
    // Save image to environment directory
    const envUploadsDir = getEnvironmentUploadsDir(sanitizedEnv, true);
    const filePath = path.join(envUploadsDir, filename);
    
    fs.writeFileSync(filePath, imageBuffer);
    
    // Emit file update to all clients in the environment
    io.to(sanitizedEnv).emit('fileUpdate');
    io.emit('fileUpdate'); // Broadcast to all for better compatibility
    
    res.json({ 
      success: true, 
      filename: filename,
      message: 'Image pasted successfully' 
    });
    
  } catch (error) {
    console.error('Error handling pasted image:', error);
    res.status(500).json({ error: 'Failed to process pasted image: ' + error.message });
  }
});

app.post('/:environment/upload', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const userAgent = req.headers['user-agent'] || '';

  upload(req, res, (err) => {
    if (err) {
      return res.status(500).send('Error uploading file(s): ' + err.message + '\n');
    }

    if (req.files.length === 0) {
      return res.status(400).send('No files uploaded' + '\n');
    }

    if (req.files.length === 1) {
      // Emit to both the environment room and broadcast to all (for better compatibility)
      io.to(sanitizedEnv).emit('fileUpdate');
      io.emit('fileUpdate'); // Broadcast to all for better compatibility
      if (req.headers['user-agent'] && (req.headers['user-agent'].includes('curl')) || userAgent.includes('wget')) {
        return res.status(200).send('Single file uploaded successfully' + '\n');
      } else {
        const redirectPath = req.params.environment ? `/${req.params.environment}` : '/';
        return res.redirect(redirectPath);
      }
    } else {
      // Emit to both the environment room and broadcast to all (for better compatibility)
      io.to(sanitizedEnv).emit('fileUpdate');
      io.emit('fileUpdate'); // Broadcast to all for better compatibility
      if (req.headers['user-agent'] && (req.headers['user-agent'].includes('curl') || userAgent.includes('wget'))) {
        return res.status(200).send('Multiple files uploaded successfully' + '\n');
      } else {
        const redirectPath = req.params.environment ? `/${req.params.environment}` : '/';
        return res.redirect(redirectPath);
      }
    }
  });
});

// Backward compatibility for root route
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
      // Emit to both the default room and broadcast to all (for better compatibility)
      io.to('default').emit('fileUpdate');
      io.emit('fileUpdate'); // Broadcast to all for better compatibility
      if (req.headers['user-agent'] && (req.headers['user-agent'].includes('curl')) || userAgent.includes('wget')) {
        return res.status(200).send('Single file uploaded successfully' + '\n');
      } else {
        return res.redirect('/');
      }
    } else {
      // Emit to both the default room and broadcast to all (for better compatibility)
      io.to('default').emit('fileUpdate');
      io.emit('fileUpdate'); // Broadcast to all for better compatibility
      if (req.headers['user-agent'] && (req.headers['user-agent'].includes('curl') || userAgent.includes('wget'))) {
        return res.status(200).send('Multiple files uploaded successfully' + '\n');
      } else {
        return res.redirect('/');
      }
    }
  });
});


app.delete('/:environment/files/:filename', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const filename = sanitizeFilename(req.params.filename);
  const envUploadsDir = getEnvironmentUploadsDir(sanitizedEnv, false);
  const filePath = path.join(envUploadsDir, filename);

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
      // Emit to both the environment room and broadcast to all (for better compatibility)
      io.to(sanitizedEnv).emit('fileUpdate');
      io.emit('fileUpdate'); // Broadcast to all for better compatibility
      res.status(200).send('File deleted successfully' + '\n');
      
      // Clean up empty environment after file deletion
      setTimeout(() => cleanupEmptyEnvironment(sanitizedEnv), 1000);
    }
  });
});

// Backward compatibility for root route
app.delete('/files/:filename', (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  const envUploadsDir = getEnvironmentUploadsDir('default', false);
  const filePath = path.join(envUploadsDir, filename);

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
      // Emit to both the default room and broadcast to all (for better compatibility)
      io.to('default').emit('fileUpdate');
      io.emit('fileUpdate'); // Broadcast to all for better compatibility
      res.status(200).send('File deleted successfully' + '\n');
      
      // Note: Don't cleanup default environment automatically
    }
  });
});

io.on('connection', (socket) => {
  // Join default room initially
  let currentEnvironment = 'default';
  socket.join(currentEnvironment);
  socket.emit('textUpdate', getSharedText(currentEnvironment));

  socket.on('joinEnvironment', (environmentName) => {
    const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
    if (currentEnvironment !== sanitizedEnv) {
      socket.leave(currentEnvironment);
      socket.join(sanitizedEnv);
      currentEnvironment = sanitizedEnv;
      socket.emit('textUpdate', getSharedText(sanitizedEnv));
    }
  });

  socket.on('textChange', (text) => {
    writeSharedTextToFile(currentEnvironment, text);
    socket.broadcast.to(currentEnvironment).emit('textUpdate', text);
  });

  socket.on('fileUpdate', () => {
    const envUploadsDir = getEnvironmentUploadsDir(currentEnvironment, false);
    if (fs.existsSync(envUploadsDir)) {
      fs.readdir(envUploadsDir, (err, files) => {
        if (err) {
          console.error('Error reading environment files:', err);
          files = [];
        }
        io.to(currentEnvironment).emit('fileList', files);
        // Also emit a general fileUpdate for better compatibility
        io.to(currentEnvironment).emit('fileUpdate');
      });
    } else {
      // Directory doesn't exist, emit empty file list
      io.to(currentEnvironment).emit('fileList', []);
      // Also emit a general fileUpdate for better compatibility
      io.to(currentEnvironment).emit('fileUpdate');
    }
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

// Periodic cleanup of empty environments (every 5 minutes)
const cleanupAllEmptyEnvironments = () => {
  console.log('Running periodic cleanup of empty environments...');
  
  // Check uploads directory for empty environment folders
  if (fs.existsSync(uploadsDir)) {
    try {
      const environments = fs.readdirSync(uploadsDir);
      environments.forEach(env => {
        if (env !== 'default') { // Never cleanup default
          cleanupEmptyEnvironment(env);
        }
      });
    } catch (err) {
      console.error('Error during periodic environment cleanup:', err);
    }
  }
  
  // Check sharedText directory for empty text files
  if (fs.existsSync(sharedTextDir)) {
    try {
      const textFiles = fs.readdirSync(sharedTextDir);
      textFiles.forEach(file => {
        const envName = file.replace('.txt', '');
        if (envName !== 'default') { // Never cleanup default
          cleanupEmptyEnvironment(envName);
        }
      });
    } catch (err) {
      console.error('Error during periodic text cleanup:', err);
    }
  }
};

setInterval(cleanupAllEmptyEnvironments, 5 * 60 * 1000); // Run every 5 minutes

server.listen(port, host, () => {
  console.log(`Server is running on http://${host}:${port}`);
  if (host === '0.0.0.0') {
    const localIP = getLocalIPAddress();
    console.log(`Access it using http://${localIP}:${port}`);
  }
});

export default app; // Export the app for testing
