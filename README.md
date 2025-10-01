# RealTime-Clipboard 2.1

A powerful real-time web application built with Node.js, Express, and Socket.IO that enables seamless text and file sharing between multiple devices without requiring login or registration. Share text and files instantly with automatic real-time synchronization across all connected devices.

> **New in v2.1**: Simplified API with native curl support! Use `curl -T` for uploads and `curl -X POST` for text updates. See [API-NEW.md](API-NEW.md) for complete documentation.

## Screenshots

<img src="/images/frontend.png" width="800">
<img src="/images/phone.png" width="300">
<img src="/images/batch.png" width="800">

## Features

### Core Features

- **Zero Configuration**: Directly access the clipboard - no rooms or login required
- **Real-time Synchronization**: Text and files update instantly across all connected devices
- **Multi-Device Support**: Share seamlessly between desktops, tablets, and mobile devices
- **CLI-Friendly**: Full support for `curl`, `wget`, and PowerShell commands

### File Management

- **Drag & Drop Upload**: Simple drag-and-drop interface for quick file uploads
- **Multiple File Upload**: Upload multiple files simultaneously with progress tracking
- **Large File Support**: Chunked upload system handles files of any size efficiently
- **File Versioning**: Automatic version control for all uploaded files
  - Keep track of all file versions with timestamps
  - Restore previous versions with one click
  - Compare and manage different file versions
- **Smart File Previews**:
  - In-browser preview for images (JPG, PNG, GIF, WebP, SVG, BMP, TIFF)
  - Text file preview with syntax highlighting
  - PDF viewer integrated in the browser
- **Clipboard Image Paste**: Paste images directly from clipboard (Ctrl+V/Cmd+V)
- **File Deletion**: Delete individual versions or all versions of a file

### Environment System

- **Multiple Environments**: Create isolated workspaces using custom paths (e.g., `/myproject`, `/team`)
- **Automatic Cleanup**: Empty environments are automatically cleaned up
- **Per-Environment Files**: Each environment has its own text and file storage
- **Easy Switching**: Navigate between environments with simple URL paths

### Modern UI/UX

- **Clean, Modern Interface**: Beautiful Tailwind CSS design with dark theme
- **Responsive Design**: Works perfectly on desktop, tablet, and mobile
- **Real-time Updates**: Changes appear instantly without page refresh
- **Upload Progress Tracking**: Visual progress bars for all uploads
- **Font Awesome Icons**: Professional iconography throughout

### Developer Features

- **RESTful API**: Complete API for programmatic access
- **WebSocket Support**: Real-time updates via Socket.IO
- **Docker Support**: Easy deployment with Docker and docker-compose
- **ES Modules**: Modern JavaScript module system
- **Comprehensive Testing**: Full test suite with Mocha and Chai
- **Sanitized Filenames**: Automatic filename sanitization for security

## Prerequisites

- Node.js (v20 or higher recommended)
- npm (v10 or higher)

## Installation

1. Clone the repository:

```bash
  git clone https://github.com/SaidTorres3/realtime-clipboard.git
  cd realtime-clipboard
```

2. Install the dependencies:

```bash
  npm install
```

## Usage

### Starting the Server

1. Start the server:

```bash
  npm start
  # or
  node server.js
```

  The default host is `0.0.0.0` and the default port is `8088`.

2. To specify a custom host and port:

```bash
  node server.js -a 0.0.0.0 -p 8088
```

  To specify a custom data directory where all uploaded files and shared text will be stored:

```bash
  node server.js --datadir /path/to/your/data
```

  You can also use an environment variable:

```bash
  DATA_DIR=/path/to/your/data node server.js
```

  By default, data is stored in the `./data` directory within the application folder.

3. Access the application:
   - Open your web browser and navigate to `http://localhost:8088`
   - Replace `localhost` with your machine's IP address to access from other devices on your network

### Using Environments

Create isolated workspaces by adding a path to the URL:

- Default environment: `http://localhost:8088`
- Custom environments:
  - `http://localhost:8088/myproject`
  - `http://localhost:8088/team-alpha`
  - `http://localhost:8088/personal`

Each environment maintains its own separate text and file storage.

### Web Interface

- **Text Sharing**: Type in the textarea and your text syncs automatically across all devices
- **File Upload**:
  - Drag and drop files onto the upload area
  - Click the upload area to browse and select files
  - Paste images directly with Ctrl+V (Cmd+V on Mac)
- **File Management**:
  - Click on files to download
  - View image, txt and PDF previews by clicking the preview icon
  - See file version history by clicking the version badge
  - Delete files or specific versions using the delete button

### Docker Deployment

Using Docker Compose (recommended):

```bash
docker-compose up -d
```

Using Docker directly:

```bash
docker build -t realtime-clipboard .
docker run -p 8088:8088 realtime-clipboard
```

## API Reference

The RealTime Clipboard provides a comprehensive REST API for programmatic access. All endpoints support both the default environment and custom environments.

### Text Operations

#### Get Shared Text

```bash
# Default environment
curl http://localhost:8088

# Custom environment
curl http://localhost:8088/myproject
```

#### Update Shared Text

```bash
# Default environment
curl -X POST http://localhost:8088 -d "your text here"

# Custom environment
curl -X POST http://localhost:8088/myproject -d "your text here"
```

### File Operations

#### Upload File (using curl -T)

```bash
# Default environment - single file
curl http://localhost:8088/document.pdf -T document.pdf

# Custom environment
curl http://localhost:8088/myproject/document.pdf -T document.pdf

# Upload multiple files (multiple -T flags)
curl http://localhost:8088/file1.txt -T file1.txt http://localhost:8088/file2.txt -T file2.txt
```

#### List Files

```bash
# Default environment - simple list
curl http://localhost:8088/files

# JSON format
curl http://localhost:8088/files?json=true

# Custom environment
curl http://localhost:8088/myproject/files
```

#### Download File

```bash
# Default environment
curl http://localhost:8088/files/document.pdf --output document.pdf

# Or use -o shorthand
curl http://localhost:8088/files/document.pdf -o document.pdf

# Custom environment
curl http://localhost:8088/myproject/files/document.pdf -o document.pdf
```

#### Delete File

```bash
# Default environment - deletes all versions
curl -X DELETE http://localhost:8088/files/document.pdf

# Custom environment
curl -X DELETE http://localhost:8088/myproject/files/document.pdf
```

**Note**: The API always deletes all versions of a file. Version-specific operations are only available through the web interface.

### File Preview Operations

#### Preview Text Files

```bash
# Returns JSON with file content
curl http://localhost:8088/files/readme.txt/preview

# Custom environment
curl http://localhost:8088/myproject/files/readme.txt/preview
```

Supports: `.txt`, `.md`, `.json`, `.xml`, `.csv`, `.log`, `.yaml`, `.yml`, code files, and more

#### PDF Preview

Access PDF files directly in browser:

```
http://localhost:8088/files/document.pdf/pdf-preview
```

### Chunked Upload API (for large files)

For files larger than 10MB, the system automatically uses chunked uploads:

1. **Initiate Upload**

```bash
curl -X POST http://localhost:8088/upload/initiate \
  -H "Content-Type: application/json" \
  -d '{"fileName":"largefile.zip","fileSize":104857600,"totalChunks":10}'
```

2. **Upload Chunks** (repeat for each chunk)

```bash
curl -X POST http://localhost:8088/upload/chunk \
  -F "uploadId=UPLOAD_ID" \
  -F "chunkIndex=0" \
  -F "chunk=@chunk0.bin"
```

3. **Complete Upload**

```bash
curl -X POST http://localhost:8088/upload/complete \
  -H "Content-Type: application/json" \
  -d '{"uploadId":"UPLOAD_ID"}'
```

4. **Check Upload Status**

```bash
curl http://localhost:8088/upload/status/UPLOAD_ID
```

5. **Cancel Upload**

```bash
curl -X DELETE http://localhost:8088/upload/cancel/UPLOAD_ID
```

## Project Structure

```
realtime-clipboard/
├── server.js                 # Main server file with Express, Socket.IO, and API routes
├── package.json             # Project dependencies and scripts
├── docker-compose.yml       # Docker Compose configuration
├── Dockerfile               # Docker container configuration
├── views/
│   ├── index.ejs           # Main web interface template
│   ├── styles.css          # Custom styles and animations
│   └── tailwind.min.css    # Tailwind CSS framework
├── data/
│   ├── uploads/            # Uploaded files organized by environment
│   │   ├── default/        # Default environment files
│   │   │   └── .versions/  # File version history
│   │   └── [env-name]/     # Custom environment files
│   ├── temp/               # Temporary storage for chunked uploads
│   └── sharedText/         # Text content per environment
│       ├── default.txt     # Default environment text
│       └── [env-name].txt  # Custom environment text
├── temp/                    # Temporary storage for chunked uploads
├── test/                    # Test suite
│   ├── test.js             # Mocha test cases
│   └── test files/         # Test fixtures
└── images/                  # Documentation images
```

## Key Technologies

- **Backend Framework**: Express.js (v4.19.2)
- **Real-time Engine**: Socket.IO (v4.7.5)
- **File Upload**: Multer (v1.4.5) & Busboy (v1.6.0)
- **Template Engine**: EJS (v3.1.10)
- **Frontend Framework**: Tailwind CSS (v3.x)
- **Icons**: Font Awesome (v6.5.0)
- **Testing**: Mocha (v10.4.0) & Chai (v5.1.1)
- **Security**: sanitize-filename (v1.6.3)
- **Unique IDs**: UUID (v13.0.0)

## Configuration

### Environment Variables

```bash
HOST=0.0.0.0          # Server host (default: 0.0.0.0)
PORT=8088             # Server port (default: 8088)
DATA_DIR=./data       # Data directory for uploads and text (default: ./data)
```

### Command Line Options

```bash
node server.js -a <host> -p <port> --datadir <data_directory>
```

Example:

```bash
node server.js -a 127.0.0.1 -p 3000 --datadir /path/to/data
```

## Testing

Run the test suite:

```bash
npm test
```

The test suite includes:

- Text synchronization tests
- File upload and download tests
- Multi-environment tests
- API endpoint tests
- Real-time update tests

## Performance & Scalability

- **Chunked Uploads**: Files larger than 10MB are automatically chunked for reliable transfer
- **Automatic Cleanup**:
  - Stale upload sessions cleaned every 10 seconds
  - Empty environments cleaned every 5 minutes
  - Orphaned temporary files removed on startup
- **Memory Efficient**: Text is cached in memory and persisted to disk
- **Version Control**: Old file versions stored separately with efficient metadata tracking

## Security Features

- **Filename Sanitization**: All filenames are sanitized to prevent path traversal attacks
- **MIME Type Detection**: Proper content-type headers for secure file serving
- **Isolated Environments**: Each environment has completely separate storage
- **Upload Limits**: Configurable file size limits (default: 50MB for JSON payloads)
- **Session Cleanup**: Automatic cleanup of abandoned upload sessions

## Use Cases

- **Quick File Transfer**: Share files between your devices without USB drives or cloud storage
- **Development Teams**: Share code snippets, logs, and files in isolated team environments
- **Cross-Platform Clipboard**: Universal clipboard that works across Windows, Mac, Linux, iOS, and Android
- **Temporary File Sharing**: Quick file sharing without creating accounts or permanent storage
- **Local Network Sharing**: Fast file transfer within your local network
- **CI/CD Integration**: Use the API to upload build artifacts or download configuration files
- **Remote Support**: Share logs and files with remote team members instantly

## Browser Support

- Chrome/Edge (v90+)
- Firefox (v88+)
- Safari (v14+)
- Mobile browsers (iOS Safari, Chrome Mobile)

## Troubleshooting

### Port Already in Use

If port 8088 is already in use:

```bash
node server.js -p 8089
```

### Cannot Access from Other Devices

1. Check your firewall settings - ensure port 8088 is open
2. Verify you're using your machine's IP address, not `localhost`
3. Ensure devices are on the same network

### Upload Fails for Large Files

- Files are automatically chunked if larger than 10MB
- Check available disk space in the `data/uploads` directory
- Increase upload limits if needed in `server.js`

### Environment Not Showing Files

- Refresh the page to resync
- Check browser console for WebSocket connection errors
- Verify the environment path in the URL

### Migration Guide

If you're using the old API in scripts:

- **Text updates**: Change `curl -X PUT` to `curl -X POST`
- **File uploads**: Can now use `curl -T file` instead of `curl -F "file=@file"`
- **Version management**: Use web interface for version-specific operations

See `API-NEW.md` for complete API documentation.

## What's New in v2.0.0

🎉 **Major Release** - Complete rewrite with modern features!

### New Features

- ✨ File versioning system with complete history tracking
- 🎨 Modern UI redesign with Tailwind CSS and dark theme
- 🌍 Multi-environment support for isolated workspaces
- 📦 Chunked upload system for large files
- 🖼️ Image paste from clipboard (Ctrl+V)
- 👁️ File preview for images, videos, PDFs, and text files
- 📊 Real-time upload progress tracking
- 🔄 Version promotion and restoration
- 🧹 Automatic cleanup of empty environments and old sessions
- 📱 Improved mobile responsive design

### Improvements

- ⚡ Better performance with optimized file handling
- 🔒 Enhanced security with filename sanitization
- 🛠️ Comprehensive API documentation
- 🐳 Docker and docker-compose support
- 🧪 Full test suite with Mocha and Chai
- 📦 ES Modules support
- 🎯 Better error handling and user feedback

### Technical Upgrades

- Upgraded to Socket.IO v4.7.5
- Modern ES6+ JavaScript throughout
- Improved WebSocket stability
- Environment management

## Changelog

### v2.0.0 (2025)

- Complete rewrite with modern architecture
- Added file versioning system
- Added multi-environment support
- Added chunked uploads for large files
- Added file preview capabilities
- Added clipboard image paste
- New modern UI with Tailwind CSS
- Improved API
- Added test suite
- Changed API commands

### v1.0.0 (Previous)

- Initial release
- Basic text sharing
- Simple file upload/download
- Docker support
- Real-time synchronization

## License

This project is licensed under the MIT License - see the `LICENSE` file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

Please make sure to:

- Update tests as appropriate
- Update documentation for new features
- Follow the existing code style
- Test your changes thoroughly

## Support

If you encounter any issues or have questions:

- Open an issue on GitHub
- Check existing issues for solutions
- Review the troubleshooting section above

## Acknowledgements

Built with these amazing open-source projects:

- **[Express](https://expressjs.com/)** - Fast, unopinionated web framework
- **[Socket.IO](https://socket.io/)** - Real-time bidirectional event-based communication
- **[Multer](https://github.com/expressjs/multer)** - Node.js middleware for handling multipart/form-data
- **[EJS](https://ejs.co/)** - Embedded JavaScript templating
- **[Tailwind CSS](https://tailwindcss.com/)** - Utility-first CSS framework
- **[Font Awesome](https://fontawesome.com/)** - Icon library and toolkit
- **[Busboy](https://github.com/mscdex/busboy)** - Streaming parser for HTML form data
- **[UUID](https://github.com/uuidjs/uuid)** - Generate RFC-compliant UUIDs
- **[Mocha](https://mochajs.org/)** & **[Chai](https://www.chaijs.com/)** - Testing frameworks

Special thanks to all contributors and users who have helped improve this project!

---

**Made with ❤️ for the open-source community**

⭐ Star this repository if you find it useful!
