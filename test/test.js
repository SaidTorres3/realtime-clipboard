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
  it('should update text on PUT /', (done) => {
    const newText = 'This is the updated text from test/test.js';
    request(app)
      .put('/')
      .set('Content-Type', 'text/plain')
      .send(newText)
      .expect(200)
      .end((err, res) => {
        expect(res.text).to.equal('Text updated successfully');
        done(err);
      });
  });

  // Test file upload endpoint
  it('should upload a file on POST /upload', (done) => {
    request(app)
      .post('/upload')
      .attach('files', path.join(__dirname, 'test-file.txt'))
      .expect(302) // Expecting a redirect to the root
      .end((err, res) => {
        if (err) return done(err);

        // Check if file exists
        fs.readdir(path.join(__dirname, '../uploads'), (err, files) => {
          if (err) return done(err);

          const uploadedFile = files.find(file => file.startsWith('test-file-') && file.endsWith('.txt'));
          expect(uploadedFile).to.not.be.undefined;
          done();
        });
      });
  });

  // Test file delete endpoint
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
          expect(res.text).to.equal('File deleted successfully');
          done();
        });
      });
  });
});
