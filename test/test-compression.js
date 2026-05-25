import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import AdmZip from 'adm-zip';

console.log("====================================================");
console.log("Starting SaveSync Brotli Compression Exporter Test...");
console.log("====================================================");

const testDir = path.resolve('test-temp-compression');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir);

const mockSaveDir = path.join(testDir, 'mock-save-folder');
if (!fs.existsSync(mockSaveDir)) fs.mkdirSync(mockSaveDir);

// Write some mock save files
fs.writeFileSync(path.join(mockSaveDir, 'save1.dat'), 'Super Mario Save File Data 1234567890'.repeat(100));
fs.writeFileSync(path.join(mockSaveDir, 'save2.dat'), 'Level 5: Fire World Completed.'.repeat(200));

console.log("[Test] Creating ZIP package from mock saves...");
const zip = new AdmZip();
zip.addLocalFolder(mockSaveDir);
const zipBuffer = zip.toBuffer();

console.log(`[Test] Original ZIP size: ${zipBuffer.length} bytes.`);

console.log("[Test] Compressing buffer with Brotli Max Quality...");
const compressedBuffer = zlib.brotliCompressSync(zipBuffer, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 9
  }
});

console.log(`[Test] Brotli Compressed size: ${compressedBuffer.length} bytes.`);
const savings = Math.round((1 - (compressedBuffer.length / zipBuffer.length)) * 100);
console.log(`[Test] Savings: ${savings}%`);

if (compressedBuffer.length >= zipBuffer.length) {
  console.error("❌ Compression failed to reduce file size!");
  process.exit(1);
}

console.log("[Test] Decompressing buffer to verify integrity...");
const decompressedBuffer = zlib.brotliDecompressSync(compressedBuffer);

if (decompressedBuffer.length !== zipBuffer.length) {
  console.error("❌ Decompressed buffer length mismatch!");
  process.exit(1);
}

if (!decompressedBuffer.equals(zipBuffer)) {
  console.error("❌ Content mismatch after decompression!");
  process.exit(1);
}

console.log("[Test] Extracting decompressed zip to confirm files match...");
const decompressedZipPath = path.join(testDir, 'decompressed.zip');
fs.writeFileSync(decompressedZipPath, decompressedBuffer);

const extractedDir = path.join(testDir, 'extracted-saves');
const extractZip = new AdmZip(decompressedZipPath);
extractZip.extractAllTo(extractedDir, true);

const f1 = fs.readFileSync(path.join(extractedDir, 'save1.dat'), 'utf8');
const f2 = fs.readFileSync(path.join(extractedDir, 'save2.dat'), 'utf8');

if (f1 !== 'Super Mario Save File Data 1234567890'.repeat(100) || f2 !== 'Level 5: Fire World Completed.'.repeat(200)) {
  console.error("❌ Extracted save files contents mismatch!");
  process.exit(1);
}

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });

console.log("====================================================");
console.log("✅ ALL COMPRESSION INTEGRITY TESTS PASSED!");
console.log("====================================================");
