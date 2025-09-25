import request from 'supertest';
import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import app from '../server.js';

// Fix __dirname and __filename in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('chrome', () => {
  const chromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

  // Test the root endpoint
  it('should return 200 on GET /', (done) => {
    request(app)
      .get('/')
      .set('User-Agent', chromeUserAgent)
      .expect(200, done);
  });

  const uploadsDir = path.join(__dirname, '../uploads');

  beforeEach(async () => {
    const files = await fs.promises.readdir(uploadsDir);
    const unlinkPromises = files.map(file => fs.promises.unlink(path.join(uploadsDir, file)));
    await Promise.all(unlinkPromises);
  });

  it('should upload a file on POST /upload', (done) => {
    request(app)
      .post('/upload')
      .set('User-Agent', chromeUserAgent)
      .attach('files', path.join(__dirname, 'test-file.txt'))
      .expect(302) // Expecting a redirect to the root
      .end((err, res) => {
        if (err) return done(err);

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

            const uploadedFile = files.find(file => file.startsWith('test-file-') && file.endsWith('.txt'));
            expect(uploadedFile).to.not.be.undefined;
            done();
          });
        });
      });
  });

  it('should delete a file on DELETE /files/:filename', (done) => {
    const filename = 'test-file.txt';
    const filePath = path.join(__dirname, '../uploads', filename);

    // First, ensure the file exists
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
          expect(res.text).to.equal('File deleted successfully\n');
          done();
        });
      });
  });
});

describe('File Upload Tests', () => {
  const chromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
  const uploadsDir = path.join(__dirname, '../uploads');
  const tempDir = path.join(__dirname, '../temp');

  beforeEach(async () => {
    // Clean uploads directory
    try {
      const files = await fs.promises.readdir(uploadsDir);
      const unlinkPromises = files.map(file => fs.promises.unlink(path.join(uploadsDir, file)));
      await Promise.all(unlinkPromises);
    } catch (err) {
      // Directory might be empty
    }

    // Clean temp directory
    try {
      const tempFiles = await fs.promises.readdir(tempDir);
      const unlinkTempPromises = tempFiles.map(file => fs.promises.unlink(path.join(tempDir, file)));
      await Promise.all(unlinkTempPromises);
    } catch (err) {
      // Directory might be empty
    }
  });

  describe('Regular File Upload', () => {
    it('should upload a small file successfully', (done) => {
      const testContent = 'This is a test file for regular upload';
      const testFilePath = path.join(__dirname, 'small-test.txt');
      
      // Create test file
      fs.writeFileSync(testFilePath, testContent);

      request(app)
        .post('/upload')
        .set('User-Agent', chromeUserAgent)
        .attach('files', testFilePath)
        .expect(302)
        .end((err, res) => {
          if (err) return done(err);

          // Verify file was uploaded
          fs.readdir(uploadsDir, (readdirErr, files) => {
            if (readdirErr) return done(readdirErr);
            
            const uploadedFile = files.find(file => file.startsWith('small-test-') && file.endsWith('.txt'));
            expect(uploadedFile).to.not.be.undefined;
            
            // Verify file content
            const uploadedContent = fs.readFileSync(path.join(uploadsDir, uploadedFile), 'utf8');
            expect(uploadedContent).to.equal(testContent);
            
            // Clean up test file
            fs.unlinkSync(testFilePath);
            done();
          });
        });
    });

    it('should upload multiple small files', (done) => {
      const testFile1 = path.join(__dirname, 'test1.txt');
      const testFile2 = path.join(__dirname, 'test2.txt');
      
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

          fs.readdir(uploadsDir, (readdirErr, files) => {
            if (readdirErr) return done(readdirErr);
            
            expect(files.length).to.equal(2);
            expect(files.some(f => f.startsWith('test1-'))).to.be.true;
            expect(files.some(f => f.startsWith('test2-'))).to.be.true;
            
            // Clean up
            fs.unlinkSync(testFile1);
            fs.unlinkSync(testFile2);
            done();
          });
        });
    });

    it('should handle file upload with special characters in filename', (done) => {
      const testContent = 'File with special characters';
      const testFilePath = path.join(__dirname, 'test file & special chars.txt');
      
      fs.writeFileSync(testFilePath, testContent);

      request(app)
        .post('/upload')
        .set('User-Agent', chromeUserAgent)
        .attach('files', testFilePath)
        .expect(302)
        .end((err, res) => {
          if (err) return done(err);

          fs.readdir(uploadsDir, (readdirErr, files) => {
            if (readdirErr) return done(readdirErr);
            
            // Should find a sanitized version of the filename
            expect(files.length).to.equal(1);
            expect(files[0]).to.match(/test_file___special_chars-\d+\.txt/);
            
            // Clean up
            fs.unlinkSync(testFilePath);
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
          expect(res.body.fileName).to.match(/large-test-file-\d+\.bin/);
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
      
      // Create test files
      testFiles.forEach(file => {
        fs.writeFileSync(path.join(uploadsDir, file), 'test content');
      });
      
      request(app)
        .get('/files?json=true')
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          
          expect(res.body).to.be.an('array');
          expect(res.body).to.include.members(testFiles);
          done();
        });
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

  const uploadsDir = path.join(__dirname, '../uploads');

  beforeEach(async () => {
    const files = await fs.promises.readdir(uploadsDir);
    const unlinkPromises = files.map(file => fs.promises.unlink(path.join(uploadsDir, file)));
    await Promise.all(unlinkPromises);
  });

  it('should upload a file on POST /upload', (done) => {
    request(app)
      .post('/upload')
      .set('User-Agent', curlUserAgent)
      .attach('files', path.join(__dirname, 'test-file.txt'))
      .expect(200) // Expecting a redirect to the root
      .end((err, res) => {
        if (err) return done(err);

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

            const uploadedFile = files.find(file => file.startsWith('test-file-') && file.endsWith('.txt'));
            expect(uploadedFile).to.not.be.undefined;
            done();
          });
        });
      });
  });

  it('should list uploaded files on GET /files', async () => {
    // Upload the file first
    await new Promise((resolve, reject) => {
      request(app)
        .post('/upload')
        .set('User-Agent', curlUserAgent)
        .attach('files', path.join(__dirname, 'test-file.txt'))
        .expect(200)
        .end((err) => {
          if (err) return reject(err);
          resolve();
        });
    });

    // Now list the files
    const res = await request(app)
      .get('/files')
      .expect(200);

    expect(res.text.trim()).to.match(/test-file-/);
  });

  it('should delete a file on DELETE /files/:filename', (done) => {
    const filename = 'test-file.txt';
    const filePath = path.join(__dirname, '../uploads', filename);

    // First, ensure the file exists
    fs.writeFileSync(filePath, 'Test content');

    request(app)
      .delete(`/files/${filename}`)
      .set('User-Agent', curlUserAgent)
      .expect(200)
      .end((err, res) => {
        if (err) return done(err);
        // Check if file is deleted
        fs.access(filePath, fs.constants.F_OK, (err) => {
          expect(err).to.not.be.null;
          expect(res.text).to.equal('File deleted successfully\n');
          done();
        });
      });
  });
});
