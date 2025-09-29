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

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Create shared text directory
const sharedTextDir = path.join(dataDir, 'sharedText');
if (!fs.existsSync(sharedTextDir)) {
  fs.mkdirSync(sharedTextDir);
}

// Create temporary directory for chunked uploads
const tempDir = path.join(dataDir, 'temp');
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

// Helper function to check if file is a text file
const isTextFile = (filename) => {
  const textExtensions = [
    '.txt', '.md', '.json', '.xml', '.csv', '.log', '.yaml', '.yml',
    '.js', '.ts', '.jsx', '.tsx', '.vue', '.svelte',
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.py', '.java', '.cpp', '.c', '.h', '.hpp', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt',
    '.sql', '.sh', '.bat', '.ps1', '.dockerfile', '.gitignore', '.env',
    '.conf', '.config', '.ini', '.properties', '.toml'
  ];
  const ext = path.extname(filename).toLowerCase();
  return textExtensions.includes(ext) || filename.toLowerCase() === 'readme' || filename.toLowerCase() === 'license';
};

// Helper function to check if file is a PDF
const isPDFFile = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.pdf';
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
      const entries = fs.readdirSync(envDir);
      for (const entry of entries) {
        if (entry === '.versions') {
          continue;
        }

        const entryPath = path.join(envDir, entry);
        try {
          const stats = fs.statSync(entryPath);
          if (stats.isFile()) {
            hasFiles = true;
            break;
          }

          if (stats.isDirectory()) {
            const nestedEntries = fs.readdirSync(entryPath);
            if (nestedEntries.length > 0) {
              hasFiles = true;
              break;
            }
          }
        } catch (statErr) {
          console.error('Error inspecting environment entry:', statErr);
        }
      }
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

const cleanupOrphanedVersionFolders = (environmentName) => {
  const envDir = getEnvironmentUploadsDir(environmentName, false);
  const versionsDir = getVersionsDir(environmentName);

  if (!fs.existsSync(versionsDir)) {
    return 0;
  }

  const existingFiles = new Set();

  if (fs.existsSync(envDir)) {
    try {
      const entries = fs.readdirSync(envDir);
      for (const entry of entries) {
        if (entry.startsWith('.')) {
          continue;
        }

        const entryPath = path.join(envDir, entry);
        try {
          const stats = fs.statSync(entryPath);
          if (stats.isFile()) {
            existingFiles.add(entry);
          }
        } catch (error) {
          console.error('Error inspecting environment file during version cleanup:', error);
        }
      }
    } catch (error) {
      console.error('Error reading environment directory during version cleanup:', error);
    }
  }

  let removedCount = 0;

  try {
    const versionFolders = fs.readdirSync(versionsDir);
    for (const folderName of versionFolders) {
      const folderPath = path.join(versionsDir, folderName);

      let shouldRemove = false;
      try {
        const stats = fs.statSync(folderPath);
        if (stats.isDirectory()) {
          const correspondingFilePath = path.join(envDir, folderName);
          shouldRemove = !existingFiles.has(folderName) && !fs.existsSync(correspondingFilePath);
        }
      } catch (error) {
        shouldRemove = true;
      }

      if (shouldRemove) {
        try {
          if (typeof fs.rmSync === 'function') {
            fs.rmSync(folderPath, { recursive: true, force: true });
          } else {
            fs.rmdirSync(folderPath, { recursive: true });
          }
          removedCount++;
        } catch (error) {
          console.error(`Error deleting orphaned version folder ${folderPath}:`, error.message);
        }
      }
    }

    if (fs.existsSync(versionsDir)) {
      const remaining = fs.readdirSync(versionsDir);
      if (remaining.length === 0) {
        fs.rmdirSync(versionsDir);
      }
    }
  } catch (error) {
    console.error('Error during orphaned version cleanup:', error.message);
  }

  if (removedCount > 0) {
    console.log(`Removed ${removedCount} orphaned version folder${removedCount !== 1 ? 's' : ''} for environment ${environmentName}`);
  }

  return removedCount;
};

// Clean up empty environment directories and text files
const cleanupEmptyEnvironment = (environmentName) => {
  cleanupOrphanedVersionFolders(environmentName);

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

// File versioning system
const getVersionsDir = (environmentName) => {
  return path.join(getEnvironmentUploadsDir(environmentName, false), '.versions');
};

const getFileVersionsDir = (environmentName, originalFileName) => {
  return path.join(getVersionsDir(environmentName), sanitizeFilename(originalFileName));
};

const getFileMetadataPath = (environmentName, originalFileName) => {
  return path.join(getFileVersionsDir(environmentName, originalFileName), 'metadata.json');
};

// File version metadata structure
const createFileMetadata = (originalFileName) => {
  return {
    originalFileName,
    versions: [],
    currentVersion: null
  };
};

const addVersionToMetadata = (metadata, versionInfo) => {
  metadata.versions.push(versionInfo);
  // Sort versions by timestamp (newest first)
  metadata.versions.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  metadata.currentVersion = metadata.versions[0];
  return metadata;
};

const readFileMetadata = (environmentName, originalFileName) => {
  const metadataPath = getFileMetadataPath(environmentName, originalFileName);
  try {
    if (fs.existsSync(metadataPath)) {
      const data = fs.readFileSync(metadataPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading file metadata:', error);
  }
  return createFileMetadata(originalFileName);
};

const writeFileMetadata = (environmentName, originalFileName, metadata) => {
  const metadataPath = getFileMetadataPath(environmentName, originalFileName);
  const versionsDir = getFileVersionsDir(environmentName, originalFileName);
  
  try {
    if (!fs.existsSync(versionsDir)) {
      fs.mkdirSync(versionsDir, { recursive: true });
    }
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  } catch (error) {
    console.error('Error writing file metadata:', error);
    throw error;
  }
};

const createNewVersion = (environmentName, originalFileName, fileSize, sourceFilePath) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const versionId = `${timestamp}-${uuidv4().substring(0, 8)}`;
  const ext = path.extname(originalFileName);
  const versionFileName = `${versionId}${ext}`;
  
  const versionsDir = getFileVersionsDir(environmentName, originalFileName);
  const versionFilePath = path.join(versionsDir, versionFileName);
  const currentFilePath = path.join(getEnvironmentUploadsDir(environmentName, true), originalFileName);
  
  // Ensure versions directory exists
  if (!fs.existsSync(versionsDir)) {
    fs.mkdirSync(versionsDir, { recursive: true });
  }
  
  // Read existing metadata
  let metadata = readFileMetadata(environmentName, originalFileName);
  
  // If a current version exists, move it to versions directory
  if (metadata.currentVersion && fs.existsSync(currentFilePath)) {
    const oldVersionFileName = `${metadata.currentVersion.versionId}${ext}`;
    const oldVersionPath = path.join(versionsDir, oldVersionFileName);
    
    if (!fs.existsSync(oldVersionPath)) {
      fs.copyFileSync(currentFilePath, oldVersionPath);
    }
  }
  
  // Copy new file to current position
  fs.copyFileSync(sourceFilePath, currentFilePath);
  
  // Create version info
  const versionInfo = {
    versionId,
    fileName: versionFileName,
    uploadedAt: new Date().toISOString(),
    fileSize,
    isImageFile: isImageFile(originalFileName),
    isTextFile: isTextFile(originalFileName),
    isPDFFile: isPDFFile(originalFileName)
  };
  
  // Update metadata
  metadata = addVersionToMetadata(metadata, versionInfo);
  writeFileMetadata(environmentName, originalFileName, metadata);
  
  return { versionInfo, metadata, finalPath: currentFilePath };
};

const getLatestVersion = (environmentName, originalFileName) => {
  const metadata = readFileMetadata(environmentName, originalFileName);
  return metadata.currentVersion;
};

const getFileVersionPath = (environmentName, originalFileName, versionId) => {
  const metadata = readFileMetadata(environmentName, originalFileName);
  const version = metadata.versions.find(v => v.versionId === versionId);
  
  if (!version) {
    return null;
  }
  
  // If it's the current version, return the main file path
  if (version.versionId === metadata.currentVersion?.versionId) {
    return path.join(getEnvironmentUploadsDir(environmentName, false), originalFileName);
  }
  
  // Otherwise, return the versioned file path
  const versionsDir = getFileVersionsDir(environmentName, originalFileName);
  return path.join(versionsDir, version.fileName);
};

const deleteFileVersion = (environmentName, originalFileName, versionId) => {
  const metadata = readFileMetadata(environmentName, originalFileName);
  const versionIndex = metadata.versions.findIndex(v => v.versionId === versionId);
  
  if (versionIndex === -1) {
    throw new Error('Version not found');
  }
  
  const version = metadata.versions[versionIndex];
  const currentFilePath = path.join(getEnvironmentUploadsDir(environmentName, false), originalFileName);
  
  // If deleting the current version
  if (version.versionId === metadata.currentVersion?.versionId) {
    // Remove current file
    if (fs.existsSync(currentFilePath)) {
      fs.unlinkSync(currentFilePath);
    }
    
    // Remove this version from metadata
    metadata.versions.splice(versionIndex, 1);
    
    // If there are other versions, promote the next most recent one
    if (metadata.versions.length > 0) {
      metadata.versions.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      metadata.currentVersion = metadata.versions[0];
      
      // Copy the new current version to main location
      const newCurrentVersionPath = getFileVersionPath(environmentName, originalFileName, metadata.currentVersion.versionId);
      if (fs.existsSync(newCurrentVersionPath)) {
        fs.copyFileSync(newCurrentVersionPath, currentFilePath);
      }
    } else {
      metadata.currentVersion = null;
    }
  } else {
    // Deleting an older version
    const versionPath = getFileVersionPath(environmentName, originalFileName, versionId);
    if (fs.existsSync(versionPath)) {
      fs.unlinkSync(versionPath);
    }
    metadata.versions.splice(versionIndex, 1);
  }
  
  // Update or remove metadata
  if (metadata.versions.length === 0) {
    // Remove metadata file and directory if no versions left
    const metadataPath = getFileMetadataPath(environmentName, originalFileName);
    const versionsDir = getFileVersionsDir(environmentName, originalFileName);
    
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }
    
    if (fs.existsSync(versionsDir)) {
      try {
        fs.rmdirSync(versionsDir);
      } catch (error) {
        // Directory might not be empty, that's okay
      }
    }
  } else {
    writeFileMetadata(environmentName, originalFileName, metadata);
  }
  
  return metadata;
};

const getAllVersionedFiles = (environmentName) => {
  const envUploadsDir = getEnvironmentUploadsDir(environmentName, false);
  const versionsDir = getVersionsDir(environmentName);
  const files = [];
  
  // Get all files from main directory
  if (fs.existsSync(envUploadsDir)) {
    const mainFiles = fs.readdirSync(envUploadsDir);
    
    for (const fileName of mainFiles) {
      if (fileName.startsWith('.')) {
        continue; // Skip hidden directories like .versions
      }
      
      const filePath = path.join(envUploadsDir, fileName);
      const stats = fs.statSync(filePath);
      
      if (stats.isFile()) {
        const metadata = readFileMetadata(environmentName, fileName);
        files.push({
          originalFileName: fileName,
          currentVersion: metadata.currentVersion,
          totalVersions: metadata.versions.length,
          versions: metadata.versions,
          isImageFile: isImageFile(fileName),
          isTextFile: isTextFile(fileName),
          isPDFFile: isPDFFile(fileName),
          size: stats.size,
          lastModified: stats.mtime
        });
      }
    }
  }
  
  return files;
};

// Setup storage for multer with versioned filename system
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const environmentName = getEnvironmentName(req);
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir); // Store in temp first, then move to versioned location
  },
  filename: (req, file, cb) => {
    // Create a temporary filename for processing
    const tempFileName = `upload-${Date.now()}-${uuidv4().substring(0, 8)}${path.extname(file.originalname)}`;
    cb(null, tempFileName);
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

// Health check / ping endpoint for connection testing
app.head('/ping', (req, res) => {
  res.status(200).end();
});

app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Keep backward compatibility for root route - MUST come before /:environment? route
app.get('/files', (req, res) => {
  try {
    const versionedFiles = getAllVersionedFiles('default');
    
    if (req.query.json) {
      if (req.query.versions === 'true') {
        // Return detailed version information
        res.json(versionedFiles);
      } else {
        // Return simple file list (just names)
        const fileNames = versionedFiles.map(file => file.originalFileName);
        res.json(fileNames);
      }
    } else {
      // Text format for curl/wget compatibility
      if (req.query.versions === 'true') {
        // Show version information in text format
        const output = versionedFiles.map(file => 
          `${file.originalFileName} (${file.totalVersions} version${file.totalVersions !== 1 ? 's' : ''})`
        ).join('\n');
        res.send(output + '\n');
      } else {
        // Simple file list
        const fileNames = versionedFiles.map(file => file.originalFileName);
        res.send(fileNames.join('\n') + '\n');
      }
    }
  } catch (error) {
    console.error('Error listing files:', error);
    if (req.query.json) {
      res.status(500).json({ error: 'Failed to list files' });
    } else {
      res.status(500).send('Error listing files\n');
    }
  }
});

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
    try {
      // Use the new versioned file system
      const versionedFiles = getAllVersionedFiles(sanitizedEnv);
      
      res.render('index', { 
        files: versionedFiles, 
        environmentName: sanitizedEnv,
        environmentPath: req.params.environment ? `/${req.params.environment}` : '',
        sharedText: sharedText
      });
    } catch (error) {
      console.error('Error loading versioned files:', error);
      res.render('index', { 
        files: [], 
        environmentName: sanitizedEnv,
        environmentPath: req.params.environment ? `/${req.params.environment}` : '',
        sharedText: sharedText
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
  
  try {
    const versionedFiles = getAllVersionedFiles(sanitizedEnv);
    
    if (req.query.json) {
      if (req.query.versions === 'true') {
        // Return detailed version information
        res.json(versionedFiles);
      } else {
        // Return simple file list (just names)
        const fileNames = versionedFiles.map(file => file.originalFileName);
        res.json(fileNames);
      }
    } else {
      // Text format for curl/wget compatibility
      if (req.query.versions === 'true') {
        // Show version information in text format
        const output = versionedFiles.map(file => 
          `${file.originalFileName} (${file.totalVersions} version${file.totalVersions !== 1 ? 's' : ''})`
        ).join('\n');
        res.send(output + '\n');
      } else {
        // Simple file list
        const fileNames = versionedFiles.map(file => file.originalFileName);
        res.send(fileNames.join('\n') + '\n');
      }
    }
  } catch (error) {
    console.error('Error listing files:', error);
    if (req.query.json) {
      res.status(500).json({ error: 'Failed to list files' });
    } else {
      res.status(500).send('Error listing files\n');
    }
  }
});

app.get('/:environment/files/:filename', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const filename = sanitizeFilename(req.params.filename);
  
  // Check if a specific version is requested
  const versionId = req.query.version;
  let filepath;
  
  if (versionId) {
    // Serve specific version
    filepath = getFileVersionPath(sanitizedEnv, filename, versionId);
    if (!filepath || !fs.existsSync(filepath)) {
      return res.status(404).send('Version not found\n');
    }
  } else {
    // Serve latest version (current file)
    const envUploadsDir = getEnvironmentUploadsDir(sanitizedEnv);
    filepath = path.join(envUploadsDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).send('File not found\n');
    }
  }

  res.download(filepath, filename, (err) => {
    if (err) {
      console.error('Error downloading the file:', err);
      if (!res.headersSent) {
        res.status(500).send('Error downloading the file\n');
      }
    }
  });
});

// Keep backward compatibility for root route
app.get('/files/:filename', (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  
  // Check if a specific version is requested
  const versionId = req.query.version;
  let filepath;
  
  if (versionId) {
    // Serve specific version
    filepath = getFileVersionPath('default', filename, versionId);
    if (!filepath || !fs.existsSync(filepath)) {
      return res.status(404).send('Version not found\n');
    }
  } else {
    // Serve latest version (current file)
    const envUploadsDir = getEnvironmentUploadsDir('default');
    filepath = path.join(envUploadsDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).send('File not found\n');
    }
  }

  res.download(filepath, filename, (err) => {
    if (err) {
      console.error('Error downloading the file:', err);
      if (!res.headersSent) {
        res.status(500).send('Error downloading the file\n');
      }
    }
  });
});

// Text preview endpoints
app.get('/:environment/files/:filename/preview', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const filename = sanitizeFilename(req.params.filename);
  
  // Check if this is a text file
  if (!isTextFile(filename)) {
    return res.status(400).json({ error: 'File is not a text file' });
  }
  
  // Check if a specific version is requested
  const versionId = req.query.version;
  let filepath;
  
  if (versionId) {
    // Serve specific version
    filepath = getFileVersionPath(sanitizedEnv, filename, versionId);
    if (!filepath || !fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Version not found' });
    }
  } else {
    // Serve latest version (current file)
    const envUploadsDir = getEnvironmentUploadsDir(sanitizedEnv);
    filepath = path.join(envUploadsDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found' });
    }
  }

  try {
    // Check file size to prevent loading very large files
    const stats = fs.statSync(filepath);
    const maxPreviewSize = 1024 * 1024; // 1MB limit for preview
    
    if (stats.size > maxPreviewSize) {
      return res.status(413).json({ 
        error: 'File too large for preview', 
        maxSize: maxPreviewSize,
        actualSize: stats.size
      });
    }
    
    const content = fs.readFileSync(filepath, 'utf8');
    const ext = path.extname(filename).toLowerCase();
    
    res.json({
      filename: filename,
      extension: ext,
      size: stats.size,
      content: content
    });
  } catch (error) {
    console.error('Error reading file for preview:', error);
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found' });
    } else if (error.message.includes('invalid encoding')) {
      res.status(415).json({ error: 'File contains binary data and cannot be previewed as text' });
    } else {
      res.status(500).json({ error: 'Failed to read file' });
    }
  }
});

// Keep backward compatibility for root route
app.get('/files/:filename/preview', (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  
  // Check if this is a text file
  if (!isTextFile(filename)) {
    return res.status(400).json({ error: 'File is not a text file' });
  }
  
  // Check if a specific version is requested
  const versionId = req.query.version;
  let filepath;
  
  if (versionId) {
    // Serve specific version
    filepath = getFileVersionPath('default', filename, versionId);
    if (!filepath || !fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Version not found' });
    }
  } else {
    // Serve latest version (current file)
    const envUploadsDir = getEnvironmentUploadsDir('default');
    filepath = path.join(envUploadsDir, filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found' });
    }
  }

  try {
    // Check file size to prevent loading very large files
    const stats = fs.statSync(filepath);
    const maxPreviewSize = 1024 * 1024; // 1MB limit for preview
    
    if (stats.size > maxPreviewSize) {
      return res.status(413).json({ 
        error: 'File too large for preview', 
        maxSize: maxPreviewSize,
        actualSize: stats.size
      });
    }
    
    const content = fs.readFileSync(filepath, 'utf8');
    const ext = path.extname(filename).toLowerCase();
    
    res.json({
      filename: filename,
      extension: ext,
      size: stats.size,
      content: content
    });
  } catch (error) {
    console.error('Error reading file for preview:', error);
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'File not found' });
    } else if (error.message.includes('invalid encoding')) {
      res.status(415).json({ error: 'File contains binary data and cannot be previewed as text' });
    } else {
      res.status(500).json({ error: 'Failed to read file' });
    }
  }
});

// PDF preview endpoints
app.get('/:environment/files/:filename/pdf-preview', (req, res) => {
  try {
    const environmentName = req.params.environment || 'default';
    const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
    const filename = req.params.filename;
    const filePath = path.join(getEnvironmentUploadsDir(sanitizedEnv), filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!isPDFFile(filename)) {
      return res.status(415).json({ error: 'File is not a PDF' });
    }

    // Set appropriate headers for PDF preview
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
    
    // Stream the PDF file
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  } catch (error) {
    console.error('Error serving PDF for preview:', error);
    res.status(500).json({ error: 'Failed to serve PDF file' });
  }
});

app.get('/files/:filename/pdf-preview', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(uploadsDir, 'default', filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!isPDFFile(filename)) {
      return res.status(415).json({ error: 'File is not a PDF' });
    }

    // Set appropriate headers for PDF preview
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
    
    // Stream the PDF file
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  } catch (error) {
    console.error('Error serving PDF for preview:', error);
    res.status(500).json({ error: 'Failed to serve PDF file' });
  }
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
  const originalFileName = sanitizeFilename(fileName); // Keep original name (sanitized)
  
  uploadSessions.set(uploadId, {
    fileName: originalFileName, // Use original filename
    originalFileName: fileName,
    fileSize: parseInt(fileSize),
    totalChunks: parseInt(totalChunks),
    uploadedChunks: 0,
    chunks: new Map(),
    createdAt: new Date(),
    environmentName: sanitizedEnv
  });

  res.json({ uploadId, fileName: originalFileName });
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
  const originalFileName = sanitizeFilename(fileName); // Keep original name (sanitized)
  
  uploadSessions.set(uploadId, {
    fileName: originalFileName, // Use original filename
    originalFileName: fileName,
    fileSize: parseInt(fileSize),
    totalChunks: parseInt(totalChunks),
    uploadedChunks: 0,
    chunks: new Map(),
    createdAt: new Date(),
    environmentName: 'default'
  });

  res.json({ uploadId, fileName: originalFileName });
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
    // Create temporary file to combine chunks
    const tempFileName = `complete-${uploadId}-${Date.now()}.tmp`;
    const tempPath = path.join(__dirname, 'temp', tempFileName);
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

    // Combine all chunks and write to temporary file
    const combinedData = Buffer.concat(chunks);
    fs.writeFileSync(tempPath, combinedData);

    // Use versioning system to handle the file
    const { versionInfo, metadata } = createNewVersion(
      session.environmentName || sanitizedEnv,
      session.fileName,
      combinedData.length,
      tempPath
    );

    // Clean up temporary file
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

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
    res.json({ 
      success: true, 
      fileName: session.fileName,
      versionInfo,
      totalVersions: metadata.versions.length
    });
    
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
    // Create temporary file to combine chunks
    const tempFileName = `complete-${uploadId}-${Date.now()}.tmp`;
    const tempPath = path.join(__dirname, 'temp', tempFileName);
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

    // Combine all chunks and write to temporary file
    const combinedData = Buffer.concat(chunks);
    fs.writeFileSync(tempPath, combinedData);

    // Use versioning system to handle the file
    const { versionInfo, metadata } = createNewVersion(
      session.environmentName || 'default',
      session.fileName,
      combinedData.length,
      tempPath
    );

    // Clean up temporary file
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

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
    res.json({ 
      success: true, 
      fileName: session.fileName,
      versionInfo,
      totalVersions: metadata.versions.length
    });
    
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
    
    // Generate original filename for pasted image
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `pasted-image-${timestamp}.${imageType}`;
    
    // Create temporary file
    const tempPath = path.join(__dirname, 'temp', `paste-${Date.now()}.${imageType}`);
    fs.writeFileSync(tempPath, imageBuffer);
    
    // Use versioning system to handle the file
    const { versionInfo, metadata } = createNewVersion(
      'default',
      filename,
      imageBuffer.length,
      tempPath
    );
    
    // Clean up temporary file
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    
    console.log(`Image saved successfully as: ${filename} (version ${metadata.versions.length})`);
    
    // Emit file update to all clients
    io.to('default').emit('fileUpdate');
    io.emit('fileUpdate'); // Broadcast to all for better compatibility
    
    res.json({ 
      success: true, 
      filename: filename,
      versionInfo,
      totalVersions: metadata.versions.length,
      message: `Image pasted successfully (version ${metadata.versions.length})` 
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
    
    // Generate original filename for pasted image
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `pasted-image-${timestamp}.${imageType}`;
    
    // Create temporary file
    const tempPath = path.join(__dirname, 'temp', `paste-${Date.now()}.${imageType}`);
    fs.writeFileSync(tempPath, imageBuffer);
    
    // Use versioning system to handle the file
    const { versionInfo, metadata } = createNewVersion(
      sanitizedEnv,
      filename,
      imageBuffer.length,
      tempPath
    );
    
    // Clean up temporary file
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    
    // Emit file update to all clients in the environment
    io.to(sanitizedEnv).emit('fileUpdate');
    io.emit('fileUpdate'); // Broadcast to all for better compatibility
    
    res.json({ 
      success: true, 
      filename: filename,
      versionInfo,
      totalVersions: metadata.versions.length,
      message: `Image pasted successfully (version ${metadata.versions.length})` 
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

    try {
      // Process each uploaded file with versioning
      const results = [];
      for (const file of req.files) {
        const originalFileName = sanitizeFilename(file.originalname);
        const { versionInfo, metadata } = createNewVersion(
          sanitizedEnv,
          originalFileName,
          file.size,
          file.path
        );
        
        // Clean up temporary file
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        
        results.push({
          originalFileName,
          versionInfo,
          totalVersions: metadata.versions.length
        });
      }

      // Emit to both the environment room and broadcast to all (for better compatibility)
      io.to(sanitizedEnv).emit('fileUpdate');
      io.emit('fileUpdate'); // Broadcast to all for better compatibility
      
      if (req.headers['user-agent'] && (req.headers['user-agent'].includes('curl')) || userAgent.includes('wget')) {
        const message = req.files.length === 1 
          ? `Single file uploaded successfully: ${results[0].originalFileName} (version ${results[0].totalVersions})\n`
          : `Multiple files uploaded successfully: ${results.map(r => `${r.originalFileName} (v${r.totalVersions})`).join(', ')}\n`;
        return res.status(200).send(message);
      } else {
        const redirectPath = req.params.environment ? `/${req.params.environment}` : '/';
        return res.redirect(redirectPath);
      }
    } catch (error) {
      console.error('Error processing uploaded files:', error);
      return res.status(500).send('Error processing uploaded file(s): ' + error.message + '\n');
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

    try {
      // Process each uploaded file with versioning
      const results = [];
      for (const file of req.files) {
        const originalFileName = sanitizeFilename(file.originalname);
        const { versionInfo, metadata } = createNewVersion(
          'default',
          originalFileName,
          file.size,
          file.path
        );
        
        // Clean up temporary file
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        
        results.push({
          originalFileName,
          versionInfo,
          totalVersions: metadata.versions.length
        });
      }

      // Emit to both the default room and broadcast to all (for better compatibility)
      io.to('default').emit('fileUpdate');
      io.emit('fileUpdate'); // Broadcast to all for better compatibility
      
      if (req.headers['user-agent'] && (req.headers['user-agent'].includes('curl')) || userAgent.includes('wget')) {
        const message = req.files.length === 1 
          ? `Single file uploaded successfully: ${results[0].originalFileName} (version ${results[0].totalVersions})\n`
          : `Multiple files uploaded successfully: ${results.map(r => `${r.originalFileName} (v${r.totalVersions})`).join(', ')}\n`;
        return res.status(200).send(message);
      } else {
        return res.redirect('/');
      }
    } catch (error) {
      console.error('Error processing uploaded files:', error);
      return res.status(500).send('Error processing uploaded file(s): ' + error.message + '\n');
    }
  });
});


app.delete('/:environment/files/:filename', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const filename = sanitizeFilename(req.params.filename);
  const versionId = req.query.version;

  try {
    if (versionId) {
      // Delete specific version
      const remainingMetadata = deleteFileVersion(sanitizedEnv, filename, versionId);
      io.to(sanitizedEnv).emit('fileUpdate');
      io.emit('fileUpdate');
      
      if (remainingMetadata.versions.length === 0) {
        res.status(200).send('File completely deleted (all versions removed)\n');
      } else {
        res.status(200).send(`Version deleted successfully (${remainingMetadata.versions.length} version${remainingMetadata.versions.length !== 1 ? 's' : ''} remaining)\n`);
      }
    } else {
      // Delete all versions of the file
      const metadata = readFileMetadata(sanitizedEnv, filename);
      if (metadata.versions.length === 0) {
        return res.status(404).send('File not found\n');
      }
      
      // Delete all versions
      for (const version of [...metadata.versions]) {
        deleteFileVersion(sanitizedEnv, filename, version.versionId);
      }
      
      io.to(sanitizedEnv).emit('fileUpdate');
      io.emit('fileUpdate');
      res.status(200).send('File deleted successfully (all versions removed)\n');
    }
    
    cleanupOrphanedVersionFolders(sanitizedEnv);
    // Clean up empty environment after file deletion
    setTimeout(() => cleanupEmptyEnvironment(sanitizedEnv), 1000);
  } catch (error) {
    console.error('Error deleting file:', error);
    if (error.message === 'Version not found') {
      res.status(404).send('Version not found\n');
    } else {
      res.status(500).send('Error deleting file: ' + error.message + '\n');
    }
  }
});

// Backward compatibility for root route
app.delete('/files/:filename', (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  const versionId = req.query.version;

  try {
    if (versionId) {
      // Delete specific version
      const remainingMetadata = deleteFileVersion('default', filename, versionId);
      io.to('default').emit('fileUpdate');
      io.emit('fileUpdate');
      
      if (remainingMetadata.versions.length === 0) {
        res.status(200).send('File completely deleted (all versions removed)\n');
      } else {
        res.status(200).send(`Version deleted successfully (${remainingMetadata.versions.length} version${remainingMetadata.versions.length !== 1 ? 's' : ''} remaining)\n`);
      }
    } else {
      // Delete all versions of the file
      const metadata = readFileMetadata('default', filename);
      if (metadata.versions.length === 0) {
        return res.status(404).send('File not found\n');
      }
      
      // Delete all versions
      for (const version of [...metadata.versions]) {
        deleteFileVersion('default', filename, version.versionId);
      }
      
      io.to('default').emit('fileUpdate');
      io.emit('fileUpdate');
      res.status(200).send('File deleted successfully (all versions removed)\n');
    }
    
    cleanupOrphanedVersionFolders('default');

    // Note: Don't cleanup default environment automatically
  } catch (error) {
    console.error('Error deleting file:', error);
    if (error.message === 'Version not found') {
      res.status(404).send('Version not found\n');
    } else {
      res.status(500).send('Error deleting file: ' + error.message + '\n');
    }
  }
});

// Version management API endpoints

// Get all versions of a specific file
app.get('/:environment/files/:filename/versions', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const filename = sanitizeFilename(req.params.filename);
  
  try {
    const metadata = readFileMetadata(sanitizedEnv, filename);
    
    if (metadata.versions.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.json({
      originalFileName: filename,
      currentVersion: metadata.currentVersion,
      totalVersions: metadata.versions.length,
      versions: metadata.versions
    });
  } catch (error) {
    console.error('Error getting file versions:', error);
    res.status(500).json({ error: 'Failed to get file versions' });
  }
});

// Backward compatibility for versions endpoint
app.get('/files/:filename/versions', (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  
  try {
    const metadata = readFileMetadata('default', filename);
    
    if (metadata.versions.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.json({
      originalFileName: filename,
      currentVersion: metadata.currentVersion,
      totalVersions: metadata.versions.length,
      versions: metadata.versions
    });
  } catch (error) {
    console.error('Error getting file versions:', error);
    res.status(500).json({ error: 'Failed to get file versions' });
  }
});

// Promote a specific version to be the current version
app.put('/:environment/files/:filename/versions/:versionId/promote', (req, res) => {
  const environmentName = req.params.environment || 'default';
  const sanitizedEnv = sanitizeFilename(environmentName) || 'default';
  const filename = sanitizeFilename(req.params.filename);
  const versionId = req.params.versionId;
  
  try {
    const metadata = readFileMetadata(sanitizedEnv, filename);
    const version = metadata.versions.find(v => v.versionId === versionId);
    
    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }
    
    // If it's already the current version, nothing to do
    if (version.versionId === metadata.currentVersion?.versionId) {
      return res.json({ 
        success: true, 
        message: 'Version is already current',
        currentVersion: metadata.currentVersion
      });
    }
    
    // Get paths
    const currentFilePath = path.join(getEnvironmentUploadsDir(sanitizedEnv, false), filename);
    const versionPath = getFileVersionPath(sanitizedEnv, filename, versionId);
    
    if (!fs.existsSync(versionPath)) {
      return res.status(404).json({ error: 'Version file not found' });
    }
    
    // Move current version to versions directory first
    if (metadata.currentVersion && fs.existsSync(currentFilePath)) {
      const currentVersionPath = getFileVersionPath(sanitizedEnv, filename, metadata.currentVersion.versionId);
      fs.copyFileSync(currentFilePath, currentVersionPath);
    }
    
    // Copy the target version to current location
    fs.copyFileSync(versionPath, currentFilePath);
    
    // Update metadata
    metadata.currentVersion = version;
    writeFileMetadata(sanitizedEnv, filename, metadata);
    
    // Emit update
    io.to(sanitizedEnv).emit('fileUpdate');
    io.emit('fileUpdate');
    
    res.json({
      success: true,
      message: 'Version promoted to current',
      currentVersion: metadata.currentVersion
    });
    
  } catch (error) {
    console.error('Error promoting version:', error);
    res.status(500).json({ error: 'Failed to promote version: ' + error.message });
  }
});

// Backward compatibility for promote endpoint
app.put('/files/:filename/versions/:versionId/promote', (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  const versionId = req.params.versionId;
  
  try {
    const metadata = readFileMetadata('default', filename);
    const version = metadata.versions.find(v => v.versionId === versionId);
    
    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }
    
    // If it's already the current version, nothing to do
    if (version.versionId === metadata.currentVersion?.versionId) {
      return res.json({ 
        success: true, 
        message: 'Version is already current',
        currentVersion: metadata.currentVersion
      });
    }
    
    // Get paths
    const currentFilePath = path.join(getEnvironmentUploadsDir('default', false), filename);
    const versionPath = getFileVersionPath('default', filename, versionId);
    
    if (!fs.existsSync(versionPath)) {
      return res.status(404).json({ error: 'Version file not found' });
    }
    
    // Move current version to versions directory first
    if (metadata.currentVersion && fs.existsSync(currentFilePath)) {
      const currentVersionPath = getFileVersionPath('default', filename, metadata.currentVersion.versionId);
      fs.copyFileSync(currentFilePath, currentVersionPath);
    }
    
    // Copy the target version to current location
    fs.copyFileSync(versionPath, currentFilePath);
    
    // Update metadata
    metadata.currentVersion = version;
    writeFileMetadata('default', filename, metadata);
    
    // Emit update
    io.to('default').emit('fileUpdate');
    io.emit('fileUpdate');
    
    res.json({
      success: true,
      message: 'Version promoted to current',
      currentVersion: metadata.currentVersion
    });
    
  } catch (error) {
    console.error('Error promoting version:', error);
    res.status(500).json({ error: 'Failed to promote version: ' + error.message });
  }
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
  // console.log('Running periodic cleanup of empty environments...');

  // Check uploads directory for empty environment folders
  if (fs.existsSync(uploadsDir)) {
    try {
      const environments = fs.readdirSync(uploadsDir);
      environments.forEach(env => {
        if (env === 'default') {
          cleanupOrphanedVersionFolders(env);
        } else {
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
