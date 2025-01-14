import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { expect } from 'chai';

describe('Filesystem Server - Copy File Tests', () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;
  let server: Server;

  before(async () => {
    // Create temp directories
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-test-'));
    sourceDir = path.join(tempDir, 'source');
    destDir = path.join(tempDir, 'dest');
    
    await fs.mkdir(sourceDir);
    await fs.mkdir(destDir);

    // Initialize server with temp directory
    server = new Server(
      { name: "test-server", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
  });

  after(async () => {
    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('copy_file tool', () => {
    it('should copy a single file successfully', async () => {
      // Create test file
      const sourceFile = path.join(sourceDir, 'test.txt');
      const destFile = path.join(destDir, 'test.txt');
      const content = 'Hello, World!';
      
      await fs.writeFile(sourceFile, content);

      // Test copy
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'callTool',
        params: {
          name: 'copy_file',
          arguments: {
            source: sourceFile,
            destination: destFile
          }
        }
      });

      // Verify
      expect(response.error).to.be.undefined;
      const copiedContent = await fs.readFile(destFile, 'utf-8');
      expect(copiedContent).to.equal(content);
    });

    it('should copy a directory recursively', async () => {
      // Create test directory structure
      const sourceSubDir = path.join(sourceDir, 'subdir');
      const sourceFile1 = path.join(sourceSubDir, 'file1.txt');
      const sourceFile2 = path.join(sourceSubDir, 'file2.txt');
      
      await fs.mkdir(sourceSubDir);
      await fs.writeFile(sourceFile1, 'File 1');
      await fs.writeFile(sourceFile2, 'File 2');

      // Test recursive copy
      const destSubDir = path.join(destDir, 'subdir');
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '2',
        method: 'callTool',
        params: {
          name: 'copy_file',
          arguments: {
            source: sourceSubDir,
            destination: destSubDir,
            recursive: true
          }
        }
      });

      // Verify
      expect(response.error).to.be.undefined;
      const destFile1 = path.join(destSubDir, 'file1.txt');
      const destFile2 = path.join(destSubDir, 'file2.txt');
      
      const content1 = await fs.readFile(destFile1, 'utf-8');
      const content2 = await fs.readFile(destFile2, 'utf-8');
      
      expect(content1).to.equal('File 1');
      expect(content2).to.equal('File 2');
    });

    it('should fail when copying directory without recursive flag', async () => {
      const sourceSubDir = path.join(sourceDir, 'subdir2');
      const destSubDir = path.join(destDir, 'subdir2');
      
      await fs.mkdir(sourceSubDir);

      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '3',
        method: 'callTool',
        params: {
          name: 'copy_file',
          arguments: {
            source: sourceSubDir,
            destination: destSubDir
          }
        }
      });

      expect(response.error).to.not.be.undefined;
      expect(response.error?.message).to.include('Source is a directory');
    });

    it('should fail when source does not exist', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '4',
        method: 'callTool',
        params: {
          name: 'copy_file',
          arguments: {
            source: path.join(sourceDir, 'nonexistent.txt'),
            destination: path.join(destDir, 'nonexistent.txt')
          }
        }
      });

      expect(response.error).to.not.be.undefined;
      expect(response.error?.message).to.include('ENOENT');
    });

    it('should validate paths are within allowed directories', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '5',
        method: 'callTool',
        params: {
          name: 'copy_file',
          arguments: {
            source: '/etc/passwd',
            destination: path.join(destDir, 'passwd')
          }
        }
      });

      expect(response.error).to.not.be.undefined;
      expect(response.error?.message).to.include('Access denied');
    });
  });
});