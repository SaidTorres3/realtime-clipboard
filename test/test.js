import request from 'supertest';
import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import app from '../server.js';

// Fix __dirname and __filename in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('File Upload and Management API', () => {
  // Test the root endpoint
  it('should return 200 on GET /', (done) => {
    request(app)
      .get('/')
      .expect(200, done);
  });

  // Test the text update endpoint
  it('should update text on PUT / and get the updated text on GET /', (done) => {
    const newText = 'This is the updated text from test/test.js';
    request(app)
      .put('/')
      .send(newText)
      .expect(200)
      .end((err, res) => {
        expect(res.text).to.equal('Text updated successfully\n');

        request(app)
          .get('/')
          .set('User-Agent', 'curl/7.79.1')
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

  it('should list uploaded files on GET /files', async () => {
    // Upload the file first
    await new Promise((resolve, reject) => {
      request(app)
        .post('/upload')
        .attach('files', path.join(__dirname, 'test-file.txt'))
        .expect(302)
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
