import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const BLOCK_SIZE = 64 * 1024; // 64KB block size

/**
 * Computes SHA-256 hash of a buffer.
 */
export function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Recursively gets all files in a directory.
 * Returns relative paths with forward slashes for cross-platform compatibility.
 */
export function getAllFiles(dirPath, baseDir = dirPath) {
  let results = [];
  if (!fs.existsSync(dirPath)) return results;
  const list = fs.readdirSync(dirPath);
  for (const file of list) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(filePath, baseDir));
    } else {
      const relPath = path.relative(baseDir, filePath).replace(/\\/g, '/');
      results.push(relPath);
    }
  }
  return results;
}

/**
 * Recursively gets all directories in a directory.
 * Returns relative paths with forward slashes for cross-platform compatibility.
 */
export function getAllDirs(dirPath, baseDir = dirPath) {
  let results = [];
  if (!fs.existsSync(dirPath)) return results;
  const list = fs.readdirSync(dirPath);
  for (const file of list) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      const relPath = path.relative(baseDir, filePath).replace(/\\/g, '/');
      results.push(relPath);
      results = results.concat(getAllDirs(filePath, baseDir));
    }
  }
  return results;
}

/**
 * Splits a file into chunks and calculates hashes for each chunk.
 */
export function getFileBlocks(filePath, size) {
  const blocks = [];
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(BLOCK_SIZE);
  let bytesRead = 0;
  let index = 0;

  try {
    while (true) {
      bytesRead = fs.readSync(fd, buffer, 0, BLOCK_SIZE, index * BLOCK_SIZE);
      if (bytesRead === 0) break;
      
      const blockBuffer = buffer.subarray(0, bytesRead);
      const hash = hashBuffer(blockBuffer);
      blocks.push({
        index,
        hash,
        length: bytesRead
      });

      index++;
      if (bytesRead < BLOCK_SIZE) break;
    }
  } finally {
    fs.closeSync(fd);
  }

  return blocks;
}

const manifestCache = new Map();

/**
 * Computes a SHA-256 hash representing the files and their hashes in a manifest.
 */
export function getManifestHash(manifest) {
  const files = manifest.files || {};
  const sortedPaths = Object.keys(files).sort();
  const parts = sortedPaths.map(p => `${p}:${files[p].hash}`);
  const dataStr = parts.join('|');
  return crypto.createHash('sha256').update(dataStr).digest('hex');
}

/**
 * Generates a save folder manifest containing files, their sizes, hashes, and block lists.
 */
export function getFolderManifest(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return {
      timestamp: new Date().toISOString(),
      latestMtime: 0,
      files: {},
      dirs: []
    };
  }

  const relPaths = getAllFiles(dirPath);
  let maxMtime = 0;
  const cacheKeyParts = [];
  const statsList = [];

  for (const relPath of relPaths) {
    const fullPath = path.join(dirPath, relPath);
    const stat = fs.statSync(fullPath);
    const size = stat.size;
    const mtimeMs = stat.mtimeMs || 0;
    if (mtimeMs > maxMtime) maxMtime = mtimeMs;
    cacheKeyParts.push(`${relPath}:${size}:${mtimeMs}`);
    statsList.push({ relPath, fullPath, size, mtimeMs });
  }

  const cacheKey = cacheKeyParts.join('|');
  const cached = manifestCache.get(dirPath);
  if (cached && cached.cacheKey === cacheKey) {
    return cached.manifest;
  }

  const manifest = {
    timestamp: new Date().toISOString(),
    latestMtime: maxMtime,
    files: {},
    dirs: getAllDirs(dirPath)
  };

  for (const { relPath, fullPath, size, mtimeMs } of statsList) {
    let hash = '';
    let blocks = [];

    if (size > 0) {
      // Calculate overall file hash
      const fileData = fs.readFileSync(fullPath);
      hash = hashBuffer(fileData);

      // For files, compute block-level hashes
      blocks = getFileBlocks(fullPath, size);
    } else {
      hash = hashBuffer(Buffer.alloc(0));
    }

    manifest.files[relPath] = {
      size,
      hash,
      blocks,
      mtime: mtimeMs
    };
  }

  manifestCache.set(dirPath, { cacheKey, manifest });
  return manifest;
}

/**
 * Compares a local manifest against a remote manifest to determine which files and blocks to request.
 * Returns the diff of what needs to be pulled from the REMOTE to update the LOCAL.
 */
export function diffManifests(localManifest, remoteManifest) {
  const diff = {
    added: [],      // Files present in remote, missing in local
    deleted: [],    // Files present in local, missing in remote (or should we keep them?)
    modified: {}    // Files present in both, but different hashes: { filename: [blockIndices] }
  };

  const localFiles = localManifest.files || {};
  const remoteFiles = remoteManifest.files || {};

  // Find added and modified files
  for (const relPath in remoteFiles) {
    const remoteFile = remoteFiles[relPath];
    const localFile = localFiles[relPath];

    if (!localFile) {
      // Remote file is missing locally
      diff.added.push(relPath);
    } else if (localFile.hash !== remoteFile.hash) {
      // File modified. Check block level diffs.
      const modifiedBlocks = [];
      const remoteBlocks = remoteFile.blocks || [];
      const localBlocks = localFile.blocks || [];

      // We compare up to the max block count of both files
      const maxBlocks = Math.max(remoteBlocks.length, localBlocks.length);
      for (let i = 0; i < maxBlocks; i++) {
        const rBlock = remoteBlocks[i];
        const lBlock = localBlocks[i];

        if (!lBlock || !rBlock || lBlock.hash !== rBlock.hash) {
          // If local block doesn't exist, or remote block doesn't exist, or their hashes differ
          modifiedBlocks.push(i);
        }
      }

      diff.modified[relPath] = {
        differentBlocks: modifiedBlocks,
        remoteBlockCount: remoteBlocks.length
      };
    }
  }

  // Find deleted files (files present locally but not in remote manifest)
  for (const relPath in localFiles) {
    if (!remoteFiles[relPath]) {
      diff.deleted.push(relPath);
    }
  }

  return diff;
}

/**
 * Reads specific blocks from a file and returns them as base64-encoded strings (or buffer array).
 */
export function readBlocks(filePath, blockIndices) {
  const chunks = [];
  if (!fs.existsSync(filePath)) return chunks;

  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(BLOCK_SIZE);

  try {
    for (const index of blockIndices) {
      const bytesRead = fs.readSync(fd, buffer, 0, BLOCK_SIZE, index * BLOCK_SIZE);
      if (bytesRead > 0) {
        chunks.push({
          index,
          data: buffer.subarray(0, bytesRead).toString('base64'),
          length: bytesRead
        });
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return chunks;
}

/**
 * Patches an existing file using incoming block chunks and the current local file.
 * Safely constructs the file in a temporary location, then replaces the original.
 */
export function patchFile(filePath, blockChunks, remoteManifestFile) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempFilePath = `${filePath}.savesync.tmp`;
  const fdWrite = fs.openSync(tempFilePath, 'w');
  
  // Reconstruct file block by block using either local file blocks or updated remote blockChunks
  let fdRead = null;
  if (fs.existsSync(filePath)) {
    fdRead = fs.openSync(filePath, 'r');
  }

  const readBuffer = Buffer.alloc(BLOCK_SIZE);
  const chunkMap = new Map(blockChunks.map(c => [c.index, c]));

  try {
    const blockCount = remoteManifestFile.blocks.length;

    for (let i = 0; i < blockCount; i++) {
      const remoteBlock = remoteManifestFile.blocks[i];
      const chunk = chunkMap.get(i);

      if (chunk) {
        // Use updated block chunk received from peer
        const blockBuffer = Buffer.from(chunk.data, 'base64');
        fs.writeSync(fdWrite, blockBuffer, 0, blockBuffer.length, i * BLOCK_SIZE);
      } else if (fdRead) {
        // Read unchanged block from the existing local file
        const bytesRead = fs.readSync(fdRead, readBuffer, 0, remoteBlock.length, i * BLOCK_SIZE);
        if (bytesRead > 0) {
          fs.writeSync(fdWrite, readBuffer, 0, bytesRead, i * BLOCK_SIZE);
        }
      } else {
        throw new Error(`Missing block ${i} for file reconstruction: No local file and no remote chunk provided.`);
      }
    }
  } finally {
    fs.closeSync(fdWrite);
    if (fdRead) fs.closeSync(fdRead);
  }

  // Double check integrity of new file
  const fileData = fs.readFileSync(tempFilePath);
  const computedHash = hashBuffer(fileData);

  if (computedHash !== remoteManifestFile.hash) {
    fs.unlinkSync(tempFilePath);
    throw new Error(`File patching integrity check failed! Expected hash ${remoteManifestFile.hash}, got ${computedHash}`);
  }

  // Atomically swap temp file with the target file
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  fs.renameSync(tempFilePath, filePath);
}

/**
 * Translates a remote path to a local path by replacing the remote home directory with the local home directory if it resides in C:\Users.
 */
export function translatePathToLocal(remotePath) {
  if (!remotePath) return remotePath;
  
  const normalizedRemote = path.normalize(remotePath);
  const prefix = 'c:\\users\\';
  if (normalizedRemote.toLowerCase().startsWith(prefix)) {
    const afterUsers = normalizedRemote.substring(prefix.length);
    const firstSlashIndex = afterUsers.indexOf(path.sep);
    if (firstSlashIndex !== -1) {
      const subPath = afterUsers.substring(firstSlashIndex + 1);
      return path.join(os.homedir(), subPath);
    }
  }
  
  return normalizedRemote;
}

/**
 * Safely resolves a base directory and a relative path, verifying
 * that the resolved path resides strictly inside the base directory.
 */
export function isSafePath(baseDir, relativePath) {
  if (!baseDir || !relativePath) return false;
  // Resolve path to handle any '..' or '.' segments
  const resolvedPath = path.resolve(path.join(baseDir, relativePath));
  const resolvedBase = path.resolve(baseDir);
  
  // Ensure the resolved path starts with the resolved base directory path
  // plus the path separator, or matches it exactly.
  return resolvedPath.startsWith(resolvedBase + path.sep) || resolvedPath === resolvedBase;
}

