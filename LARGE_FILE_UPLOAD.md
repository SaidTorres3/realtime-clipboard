# Large File Upload Implementation

This implementation adds support for uploading files larger than 50MB by bypassing Cloudflare's limit through chunked uploads.

## How It Works

### Client Side (Frontend)
1. **File Size Detection**: When files are selected for upload, the client checks if any file is larger than 45MB
2. **Chunking**: Large files are split into 45MB chunks (leaving a 5MB buffer under Cloudflare's 50MB limit)
3. **Sequential Upload**: Each chunk is uploaded sequentially with progress tracking
4. **Progress Display**: Enhanced progress bar shows current file, chunk progress, and overall completion

### Server Side (Backend)
1. **Upload Initiation**: `/upload/initiate` endpoint creates a new upload session with unique ID
2. **Chunk Reception**: `/upload/chunk` endpoint receives and stores individual chunks in temporary directory
3. **File Assembly**: `/upload/complete` endpoint combines all chunks into the final file
4. **Session Management**: Automatic cleanup of expired sessions and temporary files

## API Endpoints

### POST /upload/initiate
Starts a new chunked upload session.

**Request Body:**
```json
{
  "fileName": "large-file.zip",
  "fileSize": 104857600,
  "totalChunks": 3
}
```

**Response:**
```json
{
  "uploadId": "uuid-string",
  "fileName": "large-file-1234.zip"
}
```

### POST /upload/chunk
Uploads a single chunk of the file.

**Form Data:**
- `uploadId`: Session ID from initiate response
- `chunkIndex`: Index of current chunk (0-based)
- `chunk`: Binary data of the chunk

**Response:**
```json
{
  "success": true,
  "uploadedChunks": 2,
  "totalChunks": 3
}
```

### POST /upload/complete
Finalizes the upload by combining all chunks.

**Request Body:**
```json
{
  "uploadId": "uuid-string"
}
```

**Response:**
```json
{
  "success": true,
  "fileName": "large-file-1234.zip"
}
```

### GET /upload/status/:uploadId
Checks the status of an ongoing upload.

**Response:**
```json
{
  "fileName": "large-file.zip",
  "uploadedChunks": 2,
  "totalChunks": 3,
  "progress": 66.67
}
```

## Features

### Automatic File Size Detection
- Files ≤ 45MB: Use standard multer upload
- Files > 45MB: Use chunked upload system

### Progress Tracking
- Real-time progress bar updates
- Shows current file being processed
- Displays chunk progress for large files
- Shows percentage completion

### Error Handling
- Network error recovery
- Incomplete upload detection
- Automatic cleanup of failed uploads

### Session Management
- 30-minute session timeout
- Automatic cleanup every 5 minutes
- Temporary file cleanup on completion or failure

### Security Features
- Filename sanitization
- Random suffix generation to prevent conflicts
- Temporary file isolation
- Session-based access control

## File Size Limits

- **Cloudflare Free Tier**: 50MB per request
- **Our Chunk Size**: 45MB (5MB safety buffer)
- **Maximum File Size**: Theoretically unlimited (limited by disk space)
- **Recommended Maximum**: 10GB per file for practical performance

## Performance Considerations

### Client Side
- Sequential chunk uploads prevent overwhelming the server
- Progress feedback keeps users informed during long uploads
- Memory efficient chunk reading (doesn't load entire file into memory)

### Server Side
- Temporary chunk storage prevents memory issues
- Automatic cleanup prevents disk space accumulation
- Session tracking allows concurrent uploads from multiple users

## Browser Compatibility
- Modern browsers with File API support
- Drag & drop functionality
- Progress events for upload tracking
- FormData support for chunk uploads

## Testing

You can test large file uploads by:

1. **Web Interface**: Visit the application and drag/drop or select files > 45MB
2. **API Testing**: Use the test script provided (`test-chunked-upload.js`)
3. **Manual Testing**: Create large files and upload through the web interface

## Troubleshooting

### Common Issues

1. **Upload Fails**: Check server logs for chunk storage issues
2. **Progress Stuck**: Verify network connectivity and server response
3. **File Corruption**: Ensure all chunks are uploaded successfully
4. **Disk Space**: Monitor temporary directory for space usage

### Monitoring

- Check server logs for upload session activity
- Monitor `/temp` directory for orphaned chunks
- Track upload completion rates and error patterns

## Future Enhancements

1. **Parallel Chunk Upload**: Upload multiple chunks simultaneously
2. **Resume Capability**: Allow resuming interrupted uploads
3. **Compression**: Compress chunks before upload
4. **CDN Integration**: Direct chunk upload to cloud storage
5. **Bandwidth Throttling**: Limit upload speed for better user experience