// Test script to verify chunked upload functionality
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';

const SERVER_URL = 'http://127.0.0.1:8088';

async function testChunkedUpload() {
    console.log('Testing chunked upload functionality...');
    
    // Create a test file larger than 45MB
    const testFilePath = './test/large-test-file.bin';
    const testFileSize = 100 * 1024 * 1024; // 100MB
    const chunkSize = 45 * 1024 * 1024; // 45MB chunks
    
    console.log(`Creating ${testFileSize / (1024 * 1024)}MB test file...`);
    
    // Create test file with random data
    const buffer = Buffer.alloc(testFileSize);
    for (let i = 0; i < testFileSize; i++) {
        buffer[i] = Math.floor(Math.random() * 256);
    }
    fs.writeFileSync(testFilePath, buffer);
    
    const fileName = 'large-test-file.bin';
    const totalChunks = Math.ceil(testFileSize / chunkSize);
    
    try {
        // Step 1: Initiate upload
        console.log('1. Initiating upload session...');
        const initResponse = await fetch(`${SERVER_URL}/upload/initiate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                fileName: fileName,
                fileSize: testFileSize,
                totalChunks: totalChunks
            })
        });
        
        if (!initResponse.ok) {
            throw new Error(`Failed to initiate upload: ${initResponse.statusText}`);
        }
        
        const { uploadId } = await initResponse.json();
        console.log(`Upload session created with ID: ${uploadId}`);
        
        // Step 2: Upload chunks
        console.log(`2. Uploading ${totalChunks} chunks...`);
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const start = chunkIndex * chunkSize;
            const end = Math.min(start + chunkSize, testFileSize);
            const chunkData = buffer.slice(start, end);
            
            const formData = new FormData();
            formData.append('uploadId', uploadId);
            formData.append('chunkIndex', chunkIndex.toString());
            formData.append('chunk', chunkData, {
                filename: `chunk_${chunkIndex}`,
                contentType: 'application/octet-stream'
            });
            
            const chunkResponse = await fetch(`${SERVER_URL}/upload/chunk`, {
                method: 'POST',
                body: formData
            });
            
            if (!chunkResponse.ok) {
                throw new Error(`Failed to upload chunk ${chunkIndex}: ${chunkResponse.statusText}`);
            }
            
            const chunkResult = await chunkResponse.json();
            console.log(`Uploaded chunk ${chunkIndex + 1}/${totalChunks} (${chunkResult.uploadedChunks}/${chunkResult.totalChunks})`);
        }
        
        // Step 3: Complete upload
        console.log('3. Completing upload...');
        const completeResponse = await fetch(`${SERVER_URL}/upload/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ uploadId })
        });
        
        if (!completeResponse.ok) {
            throw new Error(`Failed to complete upload: ${completeResponse.statusText}`);
        }
        
        const result = await completeResponse.json();
        console.log(`✅ Upload completed successfully! File saved as: ${result.fileName}`);
        
        // Verify file exists and has correct size
        const uploadedFilePath = `./uploads/${result.fileName}`;
        if (fs.existsSync(uploadedFilePath)) {
            const uploadedFileSize = fs.statSync(uploadedFilePath).size;
            if (uploadedFileSize === testFileSize) {
                console.log(`✅ File verification successful! Size matches: ${uploadedFileSize} bytes`);
            } else {
                console.error(`❌ File size mismatch! Expected: ${testFileSize}, Got: ${uploadedFileSize}`);
            }
        } else {
            console.error(`❌ Uploaded file not found at: ${uploadedFilePath}`);
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    } finally {
        // Clean up test file
        if (fs.existsSync(testFilePath)) {
            fs.unlinkSync(testFilePath);
        }
    }
}

// Run test
testChunkedUpload().then(() => {
    console.log('Test completed');
    process.exit(0);
}).catch(error => {
    console.error('Test error:', error);
    process.exit(1);
});