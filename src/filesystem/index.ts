#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import os from 'os';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { diffLines, createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: mcp-server-filesystem <allowed-directory> [additional-directories...]");
  process.exit(1);
}

// Normalize all paths consistently
function normalizePath(p: string): string {
  return path.normalize(p);
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Store allowed directories in normalized form
const allowedDirectories = args.map(dir =>
  normalizePath(path.resolve(expandHome(dir)))
);

// Validate that all directories exist and are accessible
await Promise.all(args.map(async (dir) => {
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) {
      console.error(`Error: ${dir} is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error accessing directory ${dir}:`, error);
    process.exit(1);
  }
}));

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);

  const normalizedRequested = normalizePath(absolute);

  // Check if path is within allowed directories
  const isAllowed = allowedDirectories.some(dir => normalizedRequested.startsWith(dir));
  if (!isAllowed) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));
    if (!isRealPathAllowed) {
      throw new Error("Access denied - symlink target outside allowed directories");
    }
    return realPath;
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(absolute);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));
      if (!isParentAllowed) {
        throw new Error("Access denied - parent directory outside allowed directories");
      }
      return absolute;
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

// Schema definitions
const ReadFileArgsSchema = z.object({
  path: z.string(),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe('Text to search for - must match exactly'),
  newText: z.string().describe('Text to replace with')
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([])
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

// New schema for copy command
const CopyFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
  recursive: z.boolean().optional().default(false).describe('Enable recursive copying of directories'),
  preserveTimestamps: z.boolean().optional().default(false).describe('Preserve original timestamps'),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

// Utility function for copy operation
async function copyFileWithProgress(source: string, destination: string, preserveTimestamps: boolean = false): Promise<void> {
  const sourceStream = createReadStream(source);
  const destStream = createWriteStream(destination);
  
  try {
    await pipeline(sourceStream, destStream);
    
    if (preserveTimestamps) {
      const stats = await fs.stat(source);
      await fs.utimes(destination, stats.atime, stats.mtime);
    }
  } catch (error) {
    // Clean up the destination file if copy failed
    try {
      await fs.unlink(destination);
    } catch {} // Ignore cleanup errors
    throw error;
  }
}

async function copyRecursive(source: string, destination: string, preserveTimestamps: boolean = false): Promise<void> {
  const stats = await fs.stat(source);
  
  if (stats.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    
    const entries = await fs.readdir(source);
    for (const entry of entries) {
      const srcPath = path.join(source, entry);
      const destPath = path.join(destination, entry);
      await copyRecursive(srcPath, destPath, preserveTimestamps);
    }
    
    if (preserveTimestamps) {
      await fs.utimes(destination, stats.atime, stats.mtime);
    }
  } else {
    await copyFileWithProgress(source, destination, preserveTimestamps);
  }
}

// Server setup and existing code continues...
[... REST OF THE EXISTING CODE UNCHANGED UNTIL THE TOOLS LIST ...]

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // ... existing tools ...
      
      // Add the new copy tool to the list
      {
        name: "copy_file",
        description: 
          "Copy files or directories from source to destination. Similar to the Unix 'cp' command, " +
          "this tool provides efficient copying with options for recursive directory copying and " +
          "timestamp preservation. Offers better performance than read+write for large files. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(CopyFileArgsSchema) as ToolInput,
      },
      
      // ... rest of existing tools ...
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      // ... existing cases ...
      
      case "copy_file": {
        const parsed = CopyFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for copy_file: ${parsed.error}`);
        }
        
        const validSourcePath = await validatePath(parsed.data.source);
        const validDestPath = await validatePath(parsed.data.destination);
        
        // Get source stats before copying
        const sourceStats = await fs.stat(validSourcePath);
        
        if (sourceStats.isDirectory() && !parsed.data.recursive) {
          throw new Error("Source is a directory but recursive flag is not set");
        }
        
        await copyRecursive(
          validSourcePath,
          validDestPath,
          parsed.data.preserveTimestamps
        );
        
        return {
          content: [{ 
            type: "text", 
            text: `Successfully copied ${parsed.data.source} to ${parsed.data.destination}` 
          }],
        };
      }
      
      // ... rest of existing cases ...
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

[... REST OF THE EXISTING CODE UNCHANGED ...]