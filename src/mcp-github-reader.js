#!/usr/bin/env node

/**
 * MCP GitHub Reader Server for Claude Desktop
 * 
 * Provides GitHub repository analysis through the MCP protocol
 * without requiring local storage or authentication.
 */

// Import the MCP SDK
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const https = require('https');
const crypto = require('crypto');

// GitHub API utilities
const GITHUB_API = 'api.github.com';

// Redirect console.log to stderr to avoid protocol issues
console.log = (...args) => {
  process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

/**
 * Simple in-memory cache for GitHub API responses
 */
const apiCache = {
  cache: {},
  
  get(key) {
    const entry = this.cache[key];
    if (entry && Date.now() < entry.expiry) {
      return entry.data;
    }
    return null;
  },
  
  set(key, data, ttlMs = 60 * 60 * 1000) { // Default TTL: 1 hour
    this.cache[key] = {
      data,
      expiry: Date.now() + ttlMs
    };
  },
  
  generateKey(path) {
    return crypto.createHash('md5').update(path).digest('hex');
  }
};

/**
 * Simple GitHub API client
 */
const github = {
  /**
   * Make an API request to GitHub
   */
  async request(path) {
    // Check cache first
    const cacheKey = apiCache.generateKey(path);
    const cachedResponse = apiCache.get(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }
    
    process.stderr.write(`[DEBUG] GitHub API request: GET ${GITHUB_API}${path}\n`);
    
    return new Promise((resolve, reject) => {
      // Use fetch-style URL for HTTPS request
      const fullUrl = `https://${GITHUB_API}${path}`;
      process.stderr.write(`[DEBUG] Full URL: ${fullUrl}\n`);
      
      const options = {
        hostname: GITHUB_API,
        path,
        method: 'GET',
        headers: {
          'User-Agent': 'mcp-github-reader/1.0',
          'Accept': 'application/vnd.github.v3+json'
        }
      };
      
      // Make the request without authentication for public repositories
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', chunk => {
          data += chunk;
        });
        
        res.on('end', () => {
          const statusCode = res.statusCode;
          process.stderr.write(`[DEBUG] GitHub API response: ${statusCode}\n`);
          
          if (statusCode >= 400) {
            // Try to make the error message more helpful
            process.stderr.write(`[ERROR] GitHub API error: ${statusCode} ${res.statusMessage}\n`);
            process.stderr.write(`[ERROR] Response data: ${data}\n`);
            
            // For 404 errors, make the message more helpful
            if (statusCode === 404) {
              reject(new Error(`Resource not found: ${path.split('/').pop()} (Status: 404)`));
            } else if (statusCode === 403) {
              reject(new Error(`API rate limit exceeded. Try again later (Status: 403)`)); 
            } else {
              reject(new Error(`GitHub API error (${statusCode}): ${data}`));
            }
          } else {
            try {
              const parsedData = JSON.parse(data);
              
              // Cache successful responses
              apiCache.set(cacheKey, parsedData);
              
              resolve(parsedData);
            } catch (e) {
              process.stderr.write(`[ERROR] JSON parse error: ${e.message}\n`);
              process.stderr.write(`[ERROR] Raw data: ${data.substring(0, 200)}...\n`);
              reject(new Error(`Failed to parse GitHub response: ${e.message}`));
            }
          }
        });
      });
      
      req.on('error', (error) => {
        process.stderr.write(`[ERROR] GitHub API request error: ${error.message}\n`);
        reject(error);
      });
      
      // Set a timeout
      req.setTimeout(10000, () => {
        process.stderr.write(`[ERROR] GitHub API request timeout for: ${path}\n`);
        req.destroy();
        reject(new Error('Request timed out after 10 seconds'));
      });
      
      req.end();
    });
  },
  
  /**
   * Get repository info
   */
  async getRepository(owner, repo) {
    return this.request(`/repos/${owner}/${repo}`);
  },
  
  /**
   * Get repository contents
   */
  async getContents(owner, repo, path = '', ref = null) {
    const query = ref ? `?ref=${ref}` : '';
    return this.request(`/repos/${owner}/${repo}/contents/${path}${query}`);
  },
  
  /**
   * Get repository tree (recursive)
   */
  async getTree(owner, repo, ref = 'main') {
    return this.request(`/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
  },
  
  /**
   * Get repository branches
   */
  async getBranches(owner, repo) {
    return this.request(`/repos/${owner}/${repo}/branches`);
  },
  
  /**
   * Get repository default branch
   */
  async getDefaultBranch(owner, repo) {
    const repoInfo = await this.getRepository(owner, repo);
    return repoInfo.default_branch;
  },
  
  /**
   * Get file content directly with better error handling
   */
  async getRepoFile(owner, repo, path, branch = null) {
    try {
      // Get default branch if not provided
      if (!branch) {
        branch = await this.getDefaultBranch(owner, repo);
      }
      
      process.stderr.write(`[DEBUG] Attempting to get file: ${owner}/${repo}/${path} (branch: ${branch})\n`);
      
      // Get contents with explicit branch
      const contents = await this.getContents(owner, repo, path, branch);
      
      // Check if it's a file
      if (contents.type !== 'file') {
        throw new Error(`Path is not a file: ${path}`);
      }
      
      // Decode the content
      return Buffer.from(contents.content, 'base64').toString('utf-8');
    } catch (error) {
      process.stderr.write(`[ERROR] Failed to get file ${path}: ${error.message}\n`);
      
      // Check if this is a 404 error
      if (error.message.includes('404') || error.message.includes('not found')) {
        // Try alternative branches if default branch failed
        try {
          // Get all branches
          const branches = await this.getBranches(owner, repo);
          
          // Check if there are other branches to try
          if (branches.length > 0) {
            let triedBranches = [branch];
            
            // Try common branch names if they exist
            const commonBranches = ['main', 'master', 'develop', 'dev'];
            
            for (const commonBranch of commonBranches) {
              // Skip the branch we already tried
              if (commonBranch === branch || triedBranches.includes(commonBranch)) {
                continue;
              }
              
              // Check if this branch exists in the repo
              if (branches.some(b => b.name === commonBranch)) {
                try {
                  process.stderr.write(`[INFO] Trying alternate branch: ${commonBranch} for ${path}\n`);
                  const contents = await this.getContents(owner, repo, path, commonBranch);
                  
                  if (contents.type === 'file') {
                    return Buffer.from(contents.content, 'base64').toString('utf-8');
                  }
                } catch (branchError) {
                  triedBranches.push(commonBranch);
                  process.stderr.write(`[DEBUG] File not found in branch ${commonBranch}\n`);
                }
              }
            }
          }
        } catch (branchesError) {
          process.stderr.write(`[DEBUG] Failed to get branches: ${branchesError.message}\n`);
        }
        
        throw new Error(`File not found: ${path} (branch: ${branch})`);
      }
      
      // Re-throw the original error
      throw error;
    }
  }
};

// Create an MCP server
const server = new McpServer({
  name: 'github-reader',
  version: '1.0.0',
  capabilities: {
    resources: [
      // All resources have been removed as they're not working properly
    ],
    tools: [
      'analyzeRepository',
      'searchRepository',
      'get_individual_file_content',
      'get_entire_repo_contents'
    ],
    prompts: [
      'repositoryOverview',
      'codeExplanation',
      'codeSearch',
      'fileContent',
      'repositoryInfo',
      'repositoryStructure',
      'branchList'
    ]
  }
});

// All resources have been removed as they're not working properly

// Add individual file content tool
server.tool(
  'get_individual_file_content',
  {
    owner: z.string().describe('Repository owner (e.g., "skydeckai")'),
    repo: z.string().describe('Repository name (e.g., "mcp-server-aidd")'),
    path: z.string().describe('Path to the file within the repository (e.g., "README.md")'),
    branch: z.string().optional().describe('Optional: Branch name (defaults to the default branch)')
  },
  async ({ owner, repo, path, branch }) => {
    try {
      process.stderr.write(`[INFO] Getting file contents for ${owner}/${repo}/${path}\n`);
      
      // Get default branch if not specified
      if (!branch) {
        try {
          const repoInfo = await github.getRepository(owner, repo);
          branch = repoInfo.default_branch;
        } catch (error) {
          process.stderr.write(`[WARN] Failed to get default branch: ${error.message}\n`);
          branch = 'main'; // Fallback to main
        }
      }
      
      process.stderr.write(`[INFO] Using branch: ${branch}\n`);
      
      try {
        // Get file content
        const fileContent = await github.getRepoFile(owner, repo, path, branch);
        
        // Detect binary content
        const isBinary = /[\x00-\x08\x0E-\x1F]/.test(fileContent);
        if (isBinary) {
          return {
            content: [{ 
              type: 'text', 
              text: `[Binary file content cannot be displayed. File size: ${fileContent.length} bytes]` 
            }]
          };
        }
        
        return {
          content: [{ 
            type: 'text', 
            text: fileContent 
          }]
        };
      } catch (error) {
        process.stderr.write(`[ERROR] Failed to get file content: ${error.message}\n`);
        
        // Check if file exists but is a directory
        try {
          const contents = await github.getContents(owner, repo, path, branch);
          if (Array.isArray(contents)) {
            let text = `Directory listing for: ${owner}/${repo}/${path}\n\n`;
            
            contents.forEach(item => {
              text += `- ${item.name} (${item.type})\n`;
            });
            
            return {
              content: [{ 
                type: 'text', 
                text: text 
              }]
            };
          }
        } catch (dirError) {
          // Directory check also failed, just report the original error
        }
        
        return {
          content: [{ 
            type: 'text', 
            text: `Error retrieving file content: ${error.message}\n\nPlease check that the repository, path, and branch are correct.` 
          }],
          isError: true
        };
      }
    } catch (error) {
      process.stderr.write(`[ERROR] Tool execution error: ${error.message}\n`);
      return {
        content: [{ 
          type: 'text', 
          text: `Error: ${error.message}` 
        }],
        isError: true
      };
    }
  }
);

// Add entire repository contents tool
server.tool(
  'get_entire_repo_contents',
  {
    owner: z.string().describe('Repository owner (e.g., "skydeckai")'),
    repo: z.string().describe('Repository name (e.g., "mcp-server-aidd")'),
    exclude_patterns: z.array(z.string()).optional().describe('Optional: Patterns to exclude (e.g. ["*.test.js", "node_modules/*"])'),
    include_patterns: z.array(z.string()).optional().describe('Optional: Only include files matching these patterns (e.g. ["*.js", "*.json", "*.md"])'),
    file_size_limit: z.string().optional().describe('Optional: Maximum total size of response (e.g. "5m")'),
    individual_file_size_limit: z.string().optional().describe('Optional: Skip files larger than this size (e.g. "500k")'),
    max_files: z.number().optional().describe('Optional: Maximum number of files to include (default: 50)'),
    include_contents: z.boolean().optional().describe('Optional: Whether to include file contents or just list files (default: true)'),
    use_regex: z.boolean().optional().describe('Optional: Treat exclude/include patterns as regular expressions')
  },
  async ({ 
    owner, 
    repo, 
    exclude_patterns = [], 
    include_patterns = [],
    file_size_limit = "5m", 
    individual_file_size_limit = "500k",
    max_files = 50,
    include_contents = true,
    use_regex = false 
  }) => {
    try {
      process.stderr.write(`[INFO] Getting repository contents for ${owner}/${repo}\n`);
      
      // Parse total response size limit (default reduced to 5MB)
      let totalSizeLimit = 5 * 1024 * 1024; // Default: 5MB
      if (file_size_limit) {
        const match = file_size_limit.match(/^(\d+)(k|m|b)?$/i);
        if (match) {
          const size = parseInt(match[1]);
          const unit = (match[2] || 'b').toLowerCase();
          
          if (unit === 'k') {
            totalSizeLimit = size * 1024;
          } else if (unit === 'm') {
            totalSizeLimit = size * 1024 * 1024;
          } else {
            totalSizeLimit = size;
          }
        }
      }
      process.stderr.write(`[INFO] Using total response size limit: ${totalSizeLimit} bytes\n`);
      
      // Parse individual file size limit (default reduced to 500KB)
      let individualSizeLimit = 500 * 1024; // Default: 500KB
      if (individual_file_size_limit) {
        const match = individual_file_size_limit.match(/^(\d+)(k|m|b)?$/i);
        if (match) {
          const size = parseInt(match[1]);
          const unit = (match[2] || 'b').toLowerCase();
          
          if (unit === 'k') {
            individualSizeLimit = size * 1024;
          } else if (unit === 'm') {
            individualSizeLimit = size * 1024 * 1024;
          } else {
            individualSizeLimit = size;
          }
        }
      }
      process.stderr.write(`[INFO] Using individual file size limit: ${individualSizeLimit} bytes\n`);
      
      // Get repository info
      const repoInfo = await github.getRepository(owner, repo);
      const defaultBranch = repoInfo.default_branch;
      process.stderr.write(`[INFO] Default branch: ${defaultBranch}\n`);
      
      // Get complete repository tree (recursive)
      const tree = await github.getTree(owner, repo, defaultBranch);
      
      if (!tree.tree) {
        throw new Error("Failed to retrieve repository tree");
      }
      
      // Create matchers for exclude patterns
      const excludeMatchers = exclude_patterns.map(pattern => {
        if (use_regex) {
          try {
            return new RegExp(pattern);
          } catch (e) {
            process.stderr.write(`[WARN] Invalid regex pattern: ${pattern}\n`);
            return null;
          }
        } else {
          // Convert glob to regex
          const regexPattern = pattern
            .replace(/\./g, '\\.')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
          return new RegExp(`^${regexPattern}$`);
        }
      }).filter(Boolean);
      
      // Create matchers for include patterns
      const includeMatchers = include_patterns.map(pattern => {
        if (use_regex) {
          try {
            return new RegExp(pattern);
          } catch (e) {
            process.stderr.write(`[WARN] Invalid regex pattern: ${pattern}\n`);
            return null;
          }
        } else {
          // Convert glob to regex
          const regexPattern = pattern
            .replace(/\./g, '\\.')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
          return new RegExp(`^${regexPattern}$`);
        }
      }).filter(Boolean);
      
      // Filter and sort files
      const files = tree.tree
        .filter(item => {
          // Only include blobs (files)
          if (item.type !== 'blob') return false;
          
          // Check individual file size limit - skip files that are too large
          if (item.size && item.size > individualSizeLimit) {
            process.stderr.write(`[INFO] Skipping ${item.path} (size: ${item.size} bytes, limit: ${individualSizeLimit})\n`);
            return false;
          }
          
          // Apply include patterns - if provided, file must match at least one
          if (includeMatchers.length > 0) {
            const shouldInclude = includeMatchers.some(matcher => matcher.test(item.path));
            if (!shouldInclude) {
              return false;
            }
          }
          
          // Apply exclude patterns
          if (excludeMatchers.length > 0) {
            const shouldExclude = excludeMatchers.some(matcher => matcher.test(item.path));
            if (shouldExclude) {
              process.stderr.write(`[INFO] Excluding ${item.path} (matched exclude pattern)\n`);
              return false;
            }
          }
          
          return true;
        })
        .sort((a, b) => {
          // Sort by path for consistent results
          return a.path.localeCompare(b.path);
        });
      
      // Start building the output
      let output = `# Repository: ${owner}/${repo}\n\n`;
      output += `${repoInfo.description || 'No description provided'}\n\n`;
      output += `- Branch: ${defaultBranch}\n`;
      output += `- Stars: ${repoInfo.stargazers_count}\n`;
      output += `- Forks: ${repoInfo.forks_count}\n`;
      output += `- Total files in repo: ${tree.tree.filter(item => item.type === 'blob').length}\n`;
      output += `- Files matching filter: ${files.length}\n\n`;
      
      // Try to get README first if we're including contents
      if (include_contents) {
        try {
          // Look for README.md in various case formats
          const readmeFile = tree.tree.find(item => 
            item.type === 'blob' && 
            item.path.toLowerCase() === 'readme.md'
          );
          
          if (readmeFile) {
            const readmeContent = await github.getRepoFile(owner, repo, readmeFile.path, defaultBranch);
            const truncatedReadme = readmeContent.length > 5000 
              ? readmeContent.substring(0, 5000) + "\n\n... [README truncated due to length] ...\n" 
              : readmeContent;
            
            output += `## README\n\n${truncatedReadme}\n\n`;
          }
        } catch (error) {
          process.stderr.write(`[WARN] Failed to get README: ${error.message}\n`);
          // Continue without README
        }
      }
      
      // Number of files to process - with a maximum cap
      const filesToProcess = files.slice(0, max_files);
      const totalFiles = files.length;
      const cappedFiles = filesToProcess.length;
      
      process.stderr.write(`[INFO] Processing ${cappedFiles} of ${totalFiles} files\n`);
      
      // Add summary if total files exceeds max_files
      if (totalFiles > max_files) {
        output += `> Note: This repository has ${totalFiles} matching files. Only showing the first ${cappedFiles} files to stay within rate limits.\n`;
        output += `> Tip: Use more specific include_patterns to narrow down results.\n\n`;
      }
      
      // Group files by directory - more efficient output format
      const filesByDir = {};
      filesToProcess.forEach(file => {
        const parts = file.path.split('/');
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
        
        if (!filesByDir[dir]) {
          filesByDir[dir] = [];
        }
        
        filesByDir[dir].push(file);
      });
      
      let currentSize = output.length;
      let filesIncluded = 0;
      
      // If we're not including contents, just list all files by directory
      if (!include_contents) {
        output += `## File Listing\n\n`;
        
        for (const dir of Object.keys(filesByDir).sort()) {
          if (dir) {
            output += `### ${dir}/\n\n`;
          } else {
            output += `### Root Directory\n\n`;
          }
          
          for (const file of filesByDir[dir]) {
            const filename = file.path.split('/').pop();
            const sizeKB = (file.size / 1024).toFixed(1);
            output += `- ${filename} (${sizeKB} KB)\n`;
          }
          
          output += '\n';
        }
      } else {
        // Process files by directory - with contents
        const BATCH_SIZE = 3; // Reduced batch size to avoid overwhelming API
        const DELAY_MS = 500; // Add delay between batches
        
        // Add a sleep function to avoid rate limiting
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        
        // Process directories one at a time
        for (const dir of Object.keys(filesByDir).sort()) {
          const dirFiles = filesByDir[dir];
          
          if (dir) {
            output += `\n## Directory: ${dir}/\n\n`;
          } else {
            output += `\n## Root Directory\n\n`;
          }
          
          // Process each file in directory with smaller batches
          for (let i = 0; i < dirFiles.length; i += BATCH_SIZE) {
            // Add delay between batches to avoid rate limiting
            if (i > 0) {
              await sleep(DELAY_MS);
            }
            
            const batch = dirFiles.slice(i, i + BATCH_SIZE);
            
            // Process files in parallel (but with smaller batch size)
            const results = await Promise.allSettled(
              batch.map(async file => {
                try {
                  const content = await github.getRepoFile(owner, repo, file.path, defaultBranch);
                  return { file, content };
                } catch (error) {
                  process.stderr.write(`[ERROR] Failed to get ${file.path}: ${error.message}\n`);
                  return { file, error };
                }
              })
            );
            
            // Add content to output
            for (const result of results) {
              if (result.status === 'fulfilled') {
                const { file, content, error } = result.value;
                
                if (error) {
                  output += `### ${file.path.split('/').pop()} (Error)\n\n`;
                  output += `Failed to retrieve content: ${error.message}\n\n`;
                } else {
                  // Get filename from path
                  const filename = file.path.split('/').pop();
                  
                  // Calculate size of content
                  const contentSize = content.length;
                  
                  // Check if adding this would exceed total size limit
                  if (currentSize + contentSize + 100 > totalSizeLimit) {
                    output += `### ${filename} (Truncated)\n\n`;
                    output += `File too large to include in response\n\n`;
                  } else {
                    // Add file extension detection for syntax highlighting
                    const extension = filename.includes('.') ? filename.split('.').pop() : '';
                    const codeBlockLang = extension ? extension : '';
                    
                    output += `### ${filename}\n\n`;
                    output += `\`\`\`${codeBlockLang}\n`;
                    output += content;
                    if (!content.endsWith('\n')) output += '\n';
                    output += "```\n\n";
                    
                    currentSize += contentSize + 100; // Approximate size with markdown
                    filesIncluded++;
                  }
                }
              }
            }
            
            // Check if we've hit the size limit
            if (currentSize > totalSizeLimit) {
              output += `\n## Response Truncated\n\n`;
              output += `The response has been truncated to stay within size limits. ${filesIncluded} of ${cappedFiles} files included.\n`;
              break;
            }
          }
          
          // Check if we've hit the size limit
          if (currentSize > totalSizeLimit) {
            break;
          }
        }
      }
      
      // Add guidance for rate limiting
      output += `\n## Usage Notes\n\n`;
      output += `If you're encountering rate limits, try these approaches:\n`;
      output += `1. Set \`include_contents: false\` to just list files without contents\n`;
      output += `2. Use more specific \`include_patterns\` like ["src/main.js", "src/components/*.jsx"]\n`;
      output += `3. Use \`get_individual_file_content\` for specific important files\n`;
      output += `4. Reduce \`max_files\` to a smaller number (current: ${max_files})\n`;
      
      return {
        content: [{ 
          type: 'text', 
          text: output 
        }]
      };
    } catch (error) {
      process.stderr.write(`[ERROR] Tool execution error: ${error.message}\n`);
      return {
        content: [{ 
          type: 'text', 
          text: `Error fetching repository contents: ${error.message}` 
        }],
        isError: true
      };
    }
  }
);

// Add repository analysis tool
server.tool(
  'analyzeRepository',
  { 
    repository: z.string().describe('Repository name in owner/repo format (e.g., "skydeckai/mcp-server-aidd")'),
    includeFiles: z.boolean().optional().describe('Include file list in analysis (default: false)')
  },
  async ({ repository, includeFiles = false }) => {
    try {
      // Parse repository
      const [owner, repo] = repository.split('/');
      if (!owner || !repo) {
        throw new Error('Invalid repository format. Use owner/repo format.');
      }
      
      // Get repository info
      const repoInfo = await github.getRepository(owner, repo);
      
      // Get repository tree
      const tree = await github.getTree(owner, repo, repoInfo.default_branch);
      
      // Count files by extension
      const extensions = {};
      let totalFiles = 0;
      let totalDirectories = 0;
      
      tree.tree.forEach(item => {
        if (item.type === 'blob') {
          totalFiles++;
          const ext = item.path.includes('.') 
            ? item.path.split('.').pop().toLowerCase() 
            : 'no-extension';
          
          extensions[ext] = (extensions[ext] || 0) + 1;
        } else if (item.type === 'tree') {
          totalDirectories++;
        }
      });
      
      // Sort extensions by count
      const sortedExtensions = Object.entries(extensions)
        .sort((a, b) => b[1] - a[1])
        .map(([ext, count]) => `${ext}: ${count} files (${(count / totalFiles * 100).toFixed(1)}%)`);
      
      // Format analysis
      let analysis = `# Repository Analysis: ${repository}

## Repository Information
- Name: ${repoInfo.name}
- Owner: ${repoInfo.owner.login}
- Description: ${repoInfo.description || 'No description provided'}
- Stars: ${repoInfo.stargazers_count}
- Default Branch: ${repoInfo.default_branch}

## File Statistics
- Total Files: ${totalFiles}
- Total Directories: ${totalDirectories}

## Language Breakdown
${sortedExtensions.slice(0, 10).join('\n')}
`;
      
      // Add file list if requested
      if (includeFiles && tree.tree.length <= 100) {
        analysis += '\n\n## Files\n';
        tree.tree
          .filter(item => item.type === 'blob')
          .sort((a, b) => a.path.localeCompare(b.path))
          .forEach(file => {
            analysis += `- ${file.path}\n`;
          });
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: analysis
        }]
      };
    } catch (error) {
      return {
        content: [{ 
          type: 'text', 
          text: `Error analyzing repository: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Add repository search tool
server.tool(
  'searchRepository',
  { 
    repository: z.string().describe('Repository name in owner/repo format (e.g., "skydeckai/mcp-server-aidd")'),
    query: z.string().describe('Text to search for in filenames (e.g., "function")'),
    path: z.string().optional().describe('Optional: Filter searches to a specific path (e.g., "src")')
  },
  async ({ repository, query, path = '' }) => {
    try {
      // Parse repository
      const [owner, repo] = repository.split('/');
      if (!owner || !repo) {
        throw new Error('Invalid repository format. Use owner/repo format.');
      }
      
      process.stderr.write(`[INFO] Searching repository ${owner}/${repo} for "${query}" ${path ? `in path ${path}` : ''}\n`);
      
      // Get repository info to get default branch
      const repoInfo = await github.getRepository(owner, repo);
      
      // Get repository tree
      const tree = await github.getTree(owner, repo, repoInfo.default_branch);
      
      // Search for files matching the query and path
      const queryLower = query.toLowerCase();
      const pathLower = path.toLowerCase();
      
      const matches = tree.tree.filter(item => {
        // First check if the item matches the path filter (if provided)
        if (path && !item.path.toLowerCase().startsWith(pathLower)) {
          return false;
        }
        
        // Then check if it matches the query
        return item.path.toLowerCase().includes(queryLower);
      });
      
      // Format results
      let results = `# Search Results for "${query}" in ${repository}${path ? ` (path: ${path})` : ''}\n\n`;
      
      if (matches.length === 0) {
        results += 'No files found matching your query.\n';
      } else {
        results += `Found ${matches.length} matching files:\n\n`;
        
        matches.forEach(file => {
          results += `- ${file.path} (${file.type})\n`;
        });
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: results
        }]
      };
    } catch (error) {
      return {
        content: [{ 
          type: 'text', 
          text: `Error searching repository: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Add repository overview prompt
server.prompt(
  'repositoryOverview',
  { repository: z.string().optional().describe('Repository in format owner/repo (e.g., "skydeckai/mcp-server-aidd")') },
  ({ repository = "skydeckai/mcp-server-aidd" }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please analyze the repository at ${repository} and provide:
1. A summary of its purpose based on the description and README
2. An overview of the main components and structure
3. The primary programming languages used
4. Any notable features or patterns you observe

Focus on understanding the high-level architecture and purpose rather than specific implementation details.

Note: To use this prompt, replace "${repository}" with an actual repository name in "owner/repo" format, like "skydeckai/mcp-server-aidd".`
      }
    }]
  })
);

// Add code explanation prompt
server.prompt(
  'codeExplanation',
  { 
    repository: z.string().optional().describe('Repository in format owner/repo (e.g., "skydeckai/mcp-server-aidd")'),
    path: z.string().optional().describe('Path to the file to explain (e.g., "README.md")'),
    highlightLines: z.string().optional().describe('Line ranges to highlight (e.g., "10-20,30-35")')
  },
  ({ repository = "skydeckai/mcp-server-aidd", path = "README.md", highlightLines }) => {
    // Extract owner and repo for resource references
    const [owner = "skydeckai", repo = "mcp-server-aidd"] = (repository || "").split('/');
    
    // Create text referring to the file content tool
    const message = `# Code Explanation

## File Information
- Repository: ${repository}
- Path: ${path}
${highlightLines ? `- Highlighted Lines: ${highlightLines}` : ''}

To view the file content, use:
\`get_individual_file_content\` with parameters:
{
  "owner": "${owner}",
  "repo": "${repo}",
  "path": "${path}"
}

Note: To use this prompt properly, please provide:
1. A repository name in "owner/repo" format (e.g., "skydeckai/mcp-server-aidd")
2. A file path within that repository (e.g., "README.md")

## Guidance for Explanation
When explaining this code, focus on:
1. The purpose and functionality of the code
2. Key classes, functions, and algorithms
3. The design patterns and architectural principles in use
4. How this file relates to the overall codebase
5. Any potential edge cases or considerations

Provide explanations that are clear and concise, and that help understand both the implementation details and the broader context.`;

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: message
        }
      }]
    };
  }
);

// Add code search prompt
server.prompt(
  'codeSearch',
  { 
    repository: z.string().optional().describe('Repository in format owner/repo (e.g., "skydeckai/mcp-server-aidd")'),
    pattern: z.string().optional().describe('Search pattern (e.g., "function")'),
    path: z.string().optional().describe('Optional: Filter searches to a specific path (e.g., "src")')
  },
  ({ repository = "skydeckai/mcp-server-aidd", pattern = "function", path }) => {
    // Extract owner and repo for resource references
    const [owner = "skydeckai", repo = "mcp-server-aidd"] = (repository || "").split('/');
    
    // Create message that refers to the existing search tool
    const message = `# Code Search: "${pattern}"

## Search Parameters
- Repository: ${repository}
- Pattern: \`${pattern}\`
${path ? `- Path: ${path}` : ''}

To search for this pattern, use:
\`searchRepository\` with parameters:
{
  "repository": "${repository}",
  "query": "${pattern}"${path ? `,\n  "path": "${path}"` : ''}
}

## Guidance for Search Analysis
When analyzing the search results, consider:
1. The purpose and common patterns of the matches
2. How these code segments are used throughout the codebase
3. The relationship between different matches
4. Potential areas for refactoring or improvement
5. Related code patterns that might be worth exploring

For each significant match, consider explaining:
- The function or class containing the match
- What role the matched code plays in its context
- How it connects to the overall architecture
- Any patterns or antipatterns it demonstrates

You can further explore specific files using the \`get_individual_file_content\` tool

Note: To use this prompt properly, please provide:
1. A repository name in "owner/repo" format (e.g., "skydeckai/mcp-server-aidd")
2. A search pattern to look for in the repository`;

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: message
        }
      }]
    };
  }
);

// Add repository info prompt (for the repository resource)
server.prompt(
  'repositoryInfo',
  { 
    owner: z.string().optional().describe('Repository owner (e.g., "skydeckai")'),
    repo: z.string().optional().describe('Repository name (e.g., "mcp-server-aidd")')
  },
  ({ owner = "skydeckai", repo = "mcp-server-aidd" }) => {
    const message = `# Repository Information Prompt

To get information about the ${owner}/${repo} repository, you can use the following tool:

\`\`\`
analyzeRepository
\`\`\`

with parameters:
\`\`\`json
{
  "repository": "${owner}/${repo}"
}
\`\`\`

This will provide details about the repository including:
- Basic information (name, owner, description)
- Star and fork counts
- Default branch
- Primary language 
- File statistics

Use this tool to get an overview of the repository before diving into specific files.

Note: To use this prompt properly, replace "${owner}" and "${repo}" with an actual repository owner and name (e.g., "skydeckai" and "mcp-server-aidd").
`;

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: message
        }
      }]
    };
  }
);

// Add repository structure prompt (for the structure resource)
server.prompt(
  'repositoryStructure',
  { 
    owner: z.string().optional().describe('Repository owner (e.g., "skydeckai")'),
    repo: z.string().optional().describe('Repository name (e.g., "mcp-server-aidd")'),
    path: z.string().optional().describe('Optional: Subpath within the repository to show structure for (e.g., "src")')
  },
  ({ owner = "skydeckai", repo = "mcp-server-aidd", path = '' }) => {
    const message = `# Repository Structure Prompt

To view the file structure of the ${owner}/${repo} repository${path ? ` (path: ${path})` : ''}, you can use the following tools:

1. For a high-level structure, use \`analyzeRepository\` with includeFiles parameter:
\`\`\`json
{
  "repository": "${owner}/${repo}",
  "includeFiles": true
}
\`\`\`

2. For specific files matching a pattern, use \`searchRepository\`:
\`\`\`json
{
  "repository": "${owner}/${repo}"${path ? `,
  "path": "${path}"` : ''}
}
\`\`\`

These will display:
- Files and directories organized by their location
- File types and counts
- Overall repository structure

Use this to understand the organization of the codebase and find important files to examine.

Note: To use this prompt properly, replace "${owner}" and "${repo}" with an actual repository owner and name (e.g., "skydeckai" and "mcp-server-aidd").
`;

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: message
        }
      }]
    };
  }
);

// Add file content prompt (for the file resource)
server.prompt(
  'fileContent',
  { 
    owner: z.string().optional().describe('Repository owner (e.g., "skydeckai")'),
    repo: z.string().optional().describe('Repository name (e.g., "mcp-server-aidd")'),
    path: z.string().optional().describe('Path to the file within the repository (e.g., "README.md")'),
    branch: z.string().optional().describe('Optional: Branch name (e.g., "main", defaults to the default branch)')
  },
  ({ owner = "skydeckai", repo = "mcp-server-aidd", path = "README.md", branch }) => {
    const message = `# File Content Prompt

To view the content of \`${path}\` in the ${owner}/${repo} repository${branch ? ` (branch: ${branch})` : ''}, use the \`get_individual_file_content\` tool:

\`\`\`json
{
  "name": "get_individual_file_content",
  "parameters": {
    "owner": "${owner}",
    "repo": "${repo}",
    "path": "${path}"${branch ? `,\n    "branch": "${branch}"` : ''}
  }
}
\`\`\`

This tool will return the complete content of the requested file.

Note: To use this prompt properly, please provide:
1. A repository owner (e.g., "skydeckai")
2. A repository name (e.g., "mcp-server-aidd")
3. A path to a file within that repository (e.g., "README.md")
`;

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: message
        }
      }]
    };
  }
);

// Add branch list prompt (for the branches resource)
server.prompt(
  'branchList',
  { 
    owner: z.string().optional().describe('Repository owner (e.g., "skydeckai")'),
    repo: z.string().optional().describe('Repository name (e.g., "mcp-server-aidd")')
  },
  ({ owner = "skydeckai", repo = "mcp-server-aidd" }) => {
    const message = `# Repository Branches Prompt

To list all branches in the ${owner}/${repo} repository, you can use the analyzeRepository tool to get information about the repository, including its default branch.

\`\`\`json
{
  "name": "analyzeRepository",
  "parameters": {
    "repository": "${owner}/${repo}"
  }
}
\`\`\`

This will provide general repository information including:
- The default branch of the repository
- Basic repository statistics
- Language breakdown

Use this to understand the active development branches in the repository.

Note: To use this prompt properly, replace "${owner}" and "${repo}" with an actual repository owner and name (e.g., "skydeckai" and "mcp-server-aidd").
`;

    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: message
        }
      }]
    };
  }
);

// Keep server alive by preventing the Node.js event loop from exiting
// This single line is sufficient - no intervals needed
process.stdin.resume();

// Set up exception handler to prevent crashes
process.on('uncaughtException', (error) => {
  process.stderr.write(`Uncaught exception: ${error}\n`);
});

// Use the STDIO transport
async function main() {
  try {
    process.stderr.write('Starting GitHub Reader MCP server...\n');
    
    const transport = new StdioServerTransport();
    
    // Connect the server to the transport
    await server.connect(transport);
    
    process.stderr.write('Server connected and ready!\n');
    process.stderr.write('Using anonymous access for public GitHub repositories\n');
    
    // Handle cleanup
    process.on('SIGINT', () => {
      process.stderr.write('Shutting down...\n');
      // Just exit gracefully
      process.exit(0);
    });
  } catch (error) {
    process.stderr.write(`Error starting server: ${error}\n`);
  }
}

main();
