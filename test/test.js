import request from 'supertest';
import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

// Fix __dirname and __filename in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import and create a separate server instance for testing
let server;
let app;

before(async () => {
  // Dynamically import the server module to get the app
  const serverModule = await import('../server.js');
  app = serverModule.default;
  
  // Create a separate server instance for testing on a different port
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      console.log(`Test server started on port ${server.address().port}`);
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => {
      server.close(() => {
        console.log('Test server closed');
        resolve();
      });
    });
  }
});

describe('chrome', () => {
  const chromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

  // Test the root endpoint
  it('should return 200 on GET /', (done) => {
    request(app)
      .get('/')
      .set('User-Agent', chromeUserAgent)
      .expect(200, done);
  });

  const uploadsDir = path.join(__dirname, '../uploads/default');

  beforeEach(async () => {
    // Clean up uploads directory if it exists and has files
    if (fs.existsSync(uploadsDir)) {
      try {
        const files = await fs.promises.readdir(uploadsDir);
        const unlinkPromises = files
          .filter(file => !file.startsWith('.')) // Skip hidden directories like .versions
          .map(file => fs.promises.unlink(path.join(uploadsDir, file)));
        await Promise.all(unlinkPromises);
      } catch (err) {
        // Ignore errors during cleanup
      }
    }
  });

  it('should upload a file on POST /upload', (done) => {
    // Create a test file first
    const testFilePath = path.join(__dirname, 'test-file.txt');
    fs.writeFileSync(testFilePath, 'Test file content');

    request(app)
      .post('/upload')
      .set('User-Agent', chromeUserAgent)
      .attach('files', testFilePath)
      .expect(302) // Expecting a redirect to the root
      .end((err, res) => {
        if (err) return done(err);

        // Clean up test file
        fs.unlinkSync(testFilePath);

        // Debug: Check if the uploads directory exists
        fs.access(uploadsDir, fs.constants.F_OK, (accessErr) => {
          if (accessErr) {
            console.error('Uploads directory does not exist');
            return done(accessErr);
          }

          // Debug: Print the contents of the uploads directory
          fs.readdir(uploadsDir, (readdirErr, files) => {
            if (readdirErr) {
              console.error('Error reading uploads directory:', readdirErr);
              return done(readdirErr);
            }

            // With versioning system, file should be exactly 'test-file.txt'
            const uploadedFile = files.find(file => file === 'test-file.txt');
            expect(uploadedFile).to.not.be.undefined;
            done();
          });
        });
      });
  });

  it('should delete a file on DELETE /files/:filename', (done) => {
    const filename = 'test-file.txt';
    const filePath = path.join(uploadsDir, filename);

    // First, ensure the file exists
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    fs.writeFileSync(filePath, 'Test content');

    request(app)
      .delete(`/files/${filename}`)
      .set('User-Agent', chromeUserAgent)
      .expect(200)
      .end((err, res) => {
        if (err) return done(err);
        // Check if file is deleted
        fs.access(filePath, fs.constants.F_OK, (err) => {
          expect(err).to.not.be.null;
          expect(res.text).to.equal('File deleted successfully (all versions removed)\n');
          done();
        });
      });
  });
});

describe('File Upload Tests', () => {
  const chromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
  const uploadsDir = path.join(__dirname, '../uploads/default');
  const tempDir = path.join(__dirname, '../temp');

  beforeEach(async () => {
    // Clean uploads directory
    if (fs.existsSync(uploadsDir)) {
      try {
        const files = await fs.promises.readdir(uploadsDir);
        const unlinkPromises = files
          .filter(file => !file.startsWith('.')) // Skip hidden directories like .versions
          .map(file => fs.promises.unlink(path.join(uploadsDir, file)));
        await Promise.all(unlinkPromises);
      } catch (err) {
        // Directory might be empty or files in use
      }
    }

    // Clean temp directory
    if (fs.existsSync(tempDir)) {
      try {
        const tempFiles = await fs.promises.readdir(tempDir);
        const unlinkTempPromises = tempFiles.map(file => fs.promises.unlink(path.join(tempDir, file)));
        await Promise.all(unlinkTempPromises);
      } catch (err) {
        // Directory might be empty
      }
    }
  });

  describe('Regular File Upload', () => {
    it('should upload a small file successfully', (done) => {
      const testContent = 'This is a test file for regular upload';
      const testFilePath = path.join(__dirname, 'small-test-upload.txt');
      
      // Create test file
      fs.writeFileSync(testFilePath, testContent);

      request(app)
        .post('/upload')
        .set('User-Agent', chromeUserAgent)
        .attach('files', testFilePath)
        .expect(302)
        .end((err, res) => {
          if (err) return done(err);

          // Clean up test file
          fs.unlinkSync(testFilePath);

          // Verify file was uploaded - with versioning, file should have exact name
          fs.readdir(uploadsDir, (readdirErr, files) => {
            if (readdirErr) return done(readdirErr);
            
            const uploadedFile = files.find(file => file === 'small-test-upload.txt');
            expect(uploadedFile).to.not.be.undefined;
            
            // Verify file content
            const uploadedContent = fs.readFileSync(path.join(uploadsDir, uploadedFile), 'utf8');
            expect(uploadedContent).to.equal(testContent);
            
            done();
          });
        });
    });

    it('should upload multiple small files', (done) => {
      const testFile1 = path.join(__dirname, 'test1-upload.txt');
      const testFile2 = path.join(__dirname, 'test2-upload.txt');
      
      fs.writeFileSync(testFile1, 'Content of file 1');
      fs.writeFileSync(testFile2, 'Content of file 2');

      request(app)
        .post('/upload')
        .set('User-Agent', chromeUserAgent)
        .attach('files', testFile1)
        .attach('files', testFile2)
        .expect(302)
        .end((err, res) => {
          if (err) return done(err);

          // Clean up
          fs.unlinkSync(testFile1);
          fs.unlinkSync(testFile2);

          fs.readdir(uploadsDir, (readdirErr, files) => {
            if (readdirErr) return done(readdirErr);
            
            const relevantFiles = files.filter(f => f.includes('upload.txt'));
            expect(relevantFiles.length).to.equal(2);
            expect(relevantFiles.some(f => f === 'test1-upload.txt')).to.be.true;
            expect(relevantFiles.some(f => f === 'test2-upload.txt')).to.be.true;
            
            done();
          });
        });
    });

    it('should handle file upload with special characters in filename', (done) => {
      const testContent = 'File with special characters';
      const testFilePath = path.join(__dirname, 'test file & special chars upload.txt');
      
      fs.writeFileSync(testFilePath, testContent);

      request(app)
        .post('/upload')
        .set('User-Agent', chromeUserAgent)
        .attach('files', testFilePath)
        .expect(302)
        .end((err, res) => {
          if (err) return done(err);

          // Clean up
          fs.unlinkSync(testFilePath);

          fs.readdir(uploadsDir, (readdirErr, files) => {
            if (readdirErr) return done(readdirErr);
            
            console.log('Files in directory after special chars upload:', files);
            // The file is uploaded as-is, not sanitized in the filename
            const specialCharFiles = files.filter(f => f.includes('special chars upload'));
            expect(specialCharFiles.length).to.be.at.least(1);
            // Check that the file exists with the actual filename
            expect(specialCharFiles[0]).to.equal('test file & special chars upload.txt');
            
            done();
          });
        });
    });
  });

  describe('Chunked Upload API', () => {
    it('should initiate a chunked upload session', (done) => {
      request(app)
        .post('/upload/initiate')
        .send({
          fileName: 'large-test-file.bin',
          fileSize: 100 * 1024 * 1024, // 100MB
          totalChunks: 3
        })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          
          expect(res.body).to.have.property('uploadId');
          expect(res.body).to.have.property('fileName');
          // With the new system, filename should be sanitized but exact
          expect(res.body.fileName).to.equal('large-test-file.bin');
          done();
        });
    });

    it('should reject initiate request with missing parameters', (done) => {
      request(app)
        .post('/upload/initiate')
        .send({
          fileName: 'test.bin'
          // Missing fileSize and totalChunks
        })
        .expect(400)
        .end((err, res) => {
          if (err) return done(err);
          
          expect(res.body).to.have.property('error');
          expect(res.body.error).to.equal('Missing required parameters');
          done();
        });
    });

    it('should upload a chunk successfully', (done) => {
      // First initiate upload
      request(app)
        .post('/upload/initiate')
        .send({
          fileName: 'chunk-test.bin',
          fileSize: 1024,
          totalChunks: 1
        })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          
          const { uploadId } = res.body;
          const chunkData = Buffer.alloc(1024, 'A'); // 1KB of 'A' characters
          
          // Now upload the chunk
          request(app)
            .post('/upload/chunk')
            .field('uploadId', uploadId)
            .field('chunkIndex', '0')
            .attach('chunk', chunkData, { filename: 'chunk0' })
            .expect(200)
            .end((chunkErr, chunkRes) => {
              if (chunkErr) return done(chunkErr);
              
              expect(chunkRes.body).to.have.property('success', true);
              expect(chunkRes.body).to.have.property('uploadedChunks', 1);
              expect(chunkRes.body).to.have.property('totalChunks', 1);
              done();
            });
        });
    });

    it('should complete chunked upload and create final file', (done) => {
      const testData = 'This is test data for chunked upload';
      const chunkData = Buffer.from(testData, 'utf8');
      
      // First initiate upload
      request(app)
        .post('/upload/initiate')
        .send({
          fileName: 'complete-test.txt',
          fileSize: chunkData.length,
          totalChunks: 1
        })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          
          const { uploadId, fileName } = res.body;
          
          // Upload the chunk
          request(app)
            .post('/upload/chunk')
            .field('uploadId', uploadId)
            .field('chunkIndex', '0')
            .attach('chunk', chunkData, { filename: 'chunk0' })
            .expect(200)
            .end((chunkErr, chunkRes) => {
              if (chunkErr) return done(chunkErr);
              
              // Complete the upload
              request(app)
                .post('/upload/complete')
                .send({ uploadId })
                .expect(200)
                .end((completeErr, completeRes) => {
                  if (completeErr) return done(completeErr);
                  
                  expect(completeRes.body).to.have.property('success', true);
                  expect(completeRes.body).to.have.property('fileName', fileName);
                  
                  // Verify file exists and has correct content
                  const finalFilePath = path.join(uploadsDir, fileName);
                  expect(fs.existsSync(finalFilePath)).to.be.true;
                  
                  const fileContent = fs.readFileSync(finalFilePath, 'utf8');
                  expect(fileContent).to.equal(testData);
                  done();
                });
            });
        });
    });

    it('should handle multiple chunks correctly', (done) => {
      const chunk1Data = Buffer.from('First chunk data', 'utf8');
      const chunk2Data = Buffer.from('Second chunk data', 'utf8');
      const totalSize = chunk1Data.length + chunk2Data.length;
      
      // Initiate upload
      request(app)
        .post('/upload/initiate')
        .send({
          fileName: 'multi-chunk-test.txt',
          fileSize: totalSize,
          totalChunks: 2
        })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          
          const { uploadId, fileName } = res.body;
          
          // Upload first chunk
          request(app)
            .post('/upload/chunk')
            .field('uploadId', uploadId)
            .field('chunkIndex', '0')
            .attach('chunk', chunk1Data, { filename: 'chunk0' })
            .expect(200)
            .end((chunk1Err, chunk1Res) => {
              if (chunk1Err) return done(chunk1Err);
              
              // Upload second chunk
              request(app)
                .post('/upload/chunk')
                .field('uploadId', uploadId)
                .field('chunkIndex', '1')
                .attach('chunk', chunk2Data, { filename: 'chunk1' })
                .expect(200)
                .end((chunk2Err, chunk2Res) => {
                  if (chunk2Err) return done(chunk2Err);
                  
                  // Complete upload
                  request(app)
                    .post('/upload/complete')
                    .send({ uploadId })
                    .expect(200)
                    .end((completeErr, completeRes) => {
                      if (completeErr) return done(completeErr);
                      
                      // Verify combined file
                      const finalFilePath = path.join(uploadsDir, fileName);
                      const fileContent = fs.readFileSync(finalFilePath, 'utf8');
                      expect(fileContent).to.equal('First chunk dataSecond chunk data');
                      done();
                    });
                });
            });
        });
    });

    it('should get upload status correctly', (done) => {
      // Initiate upload
      request(app)
        .post('/upload/initiate')
        .send({
          fileName: 'status-test.bin',
          fileSize: 2048,
          totalChunks: 2
        })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          
          const { uploadId } = res.body;
          
          // Check initial status
          request(app)
            .get(`/upload/status/${uploadId}`)
            .expect(200)
            .end((statusErr, statusRes) => {
              if (statusErr) return done(statusErr);
              
              expect(statusRes.body).to.have.property('fileName', 'status-test.bin');
              expect(statusRes.body).to.have.property('uploadedChunks', 0);
              expect(statusRes.body).to.have.property('totalChunks', 2);
              expect(statusRes.body).to.have.property('progress', 0);
              done();
            });
        });
    });

    it('should handle upload session not found', (done) => {
      request(app)
        .get('/upload/status/invalid-upload-id')
        .expect(404)
        .end((err, res) => {
          if (err) return done(err);
          
          expect(res.body).to.have.property('error', 'Upload session not found');
          done();
        });
    });

    it('should reject incomplete upload completion', (done) => {
      // Initiate upload with 2 chunks but only upload 1
      request(app)
        .post('/upload/initiate')
        .send({
          fileName: 'incomplete-test.bin',
          fileSize: 2048,
          totalChunks: 2
        })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          
          const { uploadId } = res.body;
          const chunkData = Buffer.alloc(1024, 'A');
          
          // Upload only first chunk
          request(app)
            .post('/upload/chunk')
            .field('uploadId', uploadId)
            .field('chunkIndex', '0')
            .attach('chunk', chunkData, { filename: 'chunk0' })
            .expect(200)
            .end((chunkErr, chunkRes) => {
              if (chunkErr) return done(chunkErr);
              
              // Try to complete with missing chunk
              request(app)
                .post('/upload/complete')
                .send({ uploadId })
                .expect(400)
                .end((completeErr, completeRes) => {
                  if (completeErr) return done(completeErr);
                  
                  expect(completeRes.body).to.have.property('error', 'Incomplete upload');
                  expect(completeRes.body).to.have.property('uploaded', 1);
                  expect(completeRes.body).to.have.property('total', 2);
                  done();
                });
            });
        });
    });

    it('should handle large file simulation (>50MB)', (done) => {
      // Simulate uploading a 60MB file in 45MB chunks
      const chunk1Size = 45 * 1024 * 1024; // 45MB
      const chunk2Size = 15 * 1024 * 1024; // 15MB
      const totalSize = chunk1Size + chunk2Size; // 60MB total
      
      const chunk1Data = Buffer.alloc(chunk1Size, 'A');
      const chunk2Data = Buffer.alloc(chunk2Size, 'B');
      
      request(app)
        .post('/upload/initiate')
        .send({
          fileName: 'large-file-sim.bin',
          fileSize: totalSize,
          totalChunks: 2
        })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          
          const { uploadId, fileName } = res.body;
          
          // Upload first 45MB chunk
          request(app)
            .post('/upload/chunk')
            .field('uploadId', uploadId)
            .field('chunkIndex', '0')
            .attach('chunk', chunk1Data, { filename: 'chunk0' })
            .timeout(30000) // 30 second timeout for large chunk
            .expect(200)
            .end((chunk1Err, chunk1Res) => {
              if (chunk1Err) return done(chunk1Err);
              
              expect(chunk1Res.body.uploadedChunks).to.equal(1);
              
              // Upload second 15MB chunk
              request(app)
                .post('/upload/chunk')
                .field('uploadId', uploadId)
                .field('chunkIndex', '1')
                .attach('chunk', chunk2Data, { filename: 'chunk1' })
                .timeout(30000)
                .expect(200)
                .end((chunk2Err, chunk2Res) => {
                  if (chunk2Err) return done(chunk2Err);
                  
                  expect(chunk2Res.body.uploadedChunks).to.equal(2);
                  
                  // Complete upload
                  request(app)
                    .post('/upload/complete')
                    .send({ uploadId })
                    .timeout(30000)
                    .expect(200)
                    .end((completeErr, completeRes) => {
                      if (completeErr) return done(completeErr);
                      
                      expect(completeRes.body.success).to.be.true;
                      
                      // Verify file size (but don't read content due to size)
                      const finalFilePath = path.join(uploadsDir, fileName);
                      expect(fs.existsSync(finalFilePath)).to.be.true;
                      
                      const stats = fs.statSync(finalFilePath);
                      expect(stats.size).to.equal(totalSize);
                      
                      // Clean up large file
                      fs.unlinkSync(finalFilePath);
                      done();
                    });
                });
            });
        });
    }).timeout(60000); // 60 second timeout for entire test

    it('should handle chunk upload with missing uploadId', (done) => {
      const chunkData = Buffer.from('test data', 'utf8');
      
      request(app)
        .post('/upload/chunk')
        .field('chunkIndex', '0')
        .attach('chunk', chunkData, { filename: 'chunk0' })
        .expect(400)
        .end((err, res) => {
          if (err) return done(err);
          
          expect(res.body).to.have.property('error', 'Missing chunk data');
          done();
        });
    });

    it('should handle chunk upload for non-existent session', (done) => {
      const chunkData = Buffer.from('test data', 'utf8');
      
      request(app)
        .post('/upload/chunk')
        .field('uploadId', 'non-existent-id')
        .field('chunkIndex', '0')
        .attach('chunk', chunkData, { filename: 'chunk0' })
        .expect(404)
        .end((err, res) => {
          if (err) return done(err);
          
          expect(res.body).to.have.property('error', 'Upload session not found');
          done();
        });
    });
  });

  describe('File Management', () => {
    it('should download uploaded file', (done) => {
      const testContent = 'Download test content';
      const fileName = 'download-test.txt';
      const filePath = path.join(uploadsDir, fileName);
      
      // Ensure uploads directory exists
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      
      // Create test file
      fs.writeFileSync(filePath, testContent);
      
      request(app)
        .get(`/files/${fileName}`)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          
          expect(res.text).to.equal(testContent);
          done();
        });
    });

    it('should return 404 for non-existent file download', (done) => {
      request(app)
        .get('/files/non-existent-file.txt')
        .expect(404)
        .end((err, res) => {
          if (err) return done(err);
          
          expect(res.text).to.equal('File not found\n');
          done();
        });
    });

    it('should list files in JSON format', (done) => {
      const testFiles = ['file1.txt', 'file2.txt'];
      
      // Upload the files via the API so they get versioned properly
      const uploadPromises = testFiles.map(fileName => {
        const testFilePath = path.join(__dirname, fileName);
        fs.writeFileSync(testFilePath, 'test content');
        
        return new Promise((resolve, reject) => {
          request(app)
            .post('/upload')
            .attach('files', testFilePath)
            .end((err, res) => {
              fs.unlinkSync(testFilePath); // Clean up temp file
              if (err) return reject(err);
              resolve();
            });
        });
      });
      
      Promise.all(uploadPromises)
        .then(() => {
          // Wait a bit for any async operations to complete
          setTimeout(() => {
            // Check what's actually in the directory
            console.log('Files in uploads dir before listing:', fs.readdirSync(uploadsDir));
            
            // Also check versions directory
            const versionsDir = path.join(uploadsDir, '.versions');
            if (fs.existsSync(versionsDir)) {
              console.log('Contents of .versions dir:', fs.readdirSync(versionsDir));
            }
            
            request(app)
              .get('/files?json=true')
              .expect(200)
              .end((err, res) => {
                if (err) return done(err);
                
                console.log('JSON response body:', res.body);
                console.log('Response type:', typeof res.body);
                expect(res.body).to.be.an('array');
                expect(res.body).to.include.members(testFiles);
                done();
              });
          }, 100);
        })
        .catch(done);
    });
  });
});

describe('curl', () => {
  const curlUserAgent = 'curl/7.79.1';

  // Test the root endpoint
  it('should return 200 on GET /', (done) => {
    request(app)
      .get('/')
      .set('User-Agent', curlUserAgent)
      .expect(200, done);
  });

  // Test the text update endpoint
  it('should update text on PUT / and get the updated text on GET /', (done) => {
    const newText = 'This is the updated text from test/test.js';
    request(app)
      .put('/')
      .set('User-Agent', curlUserAgent)
      .send(newText)
      .expect(200)
      .end((err, res) => {
        expect(res.text).to.equal('Text updated successfully\n');

        request(app)
          .get('/')
          .set('User-Agent', curlUserAgent)
          .expect(200)
          .end((err, res) => {
            expect(res.text).to.equal(newText + '\n');
            done(err);
          });
      });
  });

  const uploadsDir = path.join(__dirname, '../uploads/default');

  beforeEach(async () => {
    // Clean uploads directory if it exists and has files
    if (fs.existsSync(uploadsDir)) {
      try {
        const files = await fs.promises.readdir(uploadsDir);
        const unlinkPromises = files
          .filter(file => !file.startsWith('.')) // Skip hidden directories like .versions
          .map(file => fs.promises.unlink(path.join(uploadsDir, file)));
        await Promise.all(unlinkPromises);
      } catch (err) {
        // Ignore errors during cleanup
      }
    }
  });

  it('should upload a file on POST /upload', (done) => {
    // Create a test file first
    const testFilePath = path.join(__dirname, 'curl-test-file.txt');
    fs.writeFileSync(testFilePath, 'Curl test file content');

    request(app)
      .post('/upload')
      .set('User-Agent', curlUserAgent)
      .attach('files', testFilePath)
      .expect(200) // curl expects 200, not redirect
      .end((err, res) => {
        if (err) return done(err);

        // Clean up test file
        fs.unlinkSync(testFilePath);

        // Debug: Check if the uploads directory exists
        fs.access(uploadsDir, fs.constants.F_OK, (accessErr) => {
          if (accessErr) {
            console.error('Uploads directory does not exist');
            return done(accessErr);
          }

          // Debug: Print the contents of the uploads directory
          fs.readdir(uploadsDir, (readdirErr, files) => {
            if (readdirErr) {
              console.error('Error reading uploads directory:', readdirErr);
              return done(readdirErr);
            }

            // With versioning system, file should be exactly 'curl-test-file.txt'
            const uploadedFile = files.find(file => file === 'curl-test-file.txt');
            expect(uploadedFile).to.not.be.undefined;
            done();
          });
        });
      });
  });

  it('should list uploaded files on GET /files', async () => {
    // Create and upload the file first
    const testFilePath = path.join(__dirname, 'list-test-file.txt');
    fs.writeFileSync(testFilePath, 'List test file content');

    await new Promise((resolve, reject) => {
      request(app)
        .post('/upload')
        .set('User-Agent', curlUserAgent)
        .attach('files', testFilePath)
        .expect(200)
        .end((err) => {
          if (err) return reject(err);
          // Clean up test file
          fs.unlinkSync(testFilePath);
          resolve();
        });
    });

    // Wait a bit for any async operations to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check what's in the directory before listing  
    console.log('Files in uploads dir before curl listing:', fs.readdirSync(uploadsDir));

    // Also check versions directory
    const versionsDir = path.join(uploadsDir, '.versions');
    if (fs.existsSync(versionsDir)) {
      console.log('Contents of .versions dir:', fs.readdirSync(versionsDir));
    }

    // Now list the files with curl user agent to get text response
    const res = await request(app)
      .get('/files')
      .set('User-Agent', curlUserAgent)
      .expect(200);

    console.log('Files list response:', JSON.stringify(res.text));
    expect(res.text.trim()).to.match(/list-test-file\.txt/);
  });

  it('should delete a file on DELETE /files/:filename', (done) => {
    const filename = 'delete-test-file.txt';
    const testFilePath = path.join(__dirname, filename);
    
    // Create and upload the file first so it gets versioned properly
    fs.writeFileSync(testFilePath, 'Test content');
    
    request(app)
      .post('/upload')
      .set('User-Agent', curlUserAgent)
      .attach('files', testFilePath)
      .expect(200)
      .end((err, res) => {
        if (err) return done(err);
        
        // Clean up temp file
        fs.unlinkSync(testFilePath);

        // Now delete the uploaded file
        request(app)
          .delete(`/files/${filename}`)
          .set('User-Agent', curlUserAgent)
          .expect(200)
          .end((err, res) => {
            if (err) return done(err);
            
            // Check if file is deleted from uploads directory
            const filePath = path.join(uploadsDir, filename);
            fs.access(filePath, fs.constants.F_OK, (err) => {
              expect(err).to.not.be.null;
              expect(res.text).to.equal('File deleted successfully (all versions removed)\n');
              done();
            });
          });
      });
  });
});
