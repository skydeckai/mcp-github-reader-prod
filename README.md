# MCP GitHub Reader

A lightweight Model Context Protocol (MCP) server for bringing GitHub repositories into context for large language models.

## Features

- **API-based**: No local repository cloning required - works directly with GitHub's API
- **Repository Analysis**: Get overview and statistics for any GitHub repository
- **File Access**: Retrieve individual file contents or entire repository file structures
- **Smart Filtering**: Include or exclude files with glob and regex patterns
- **Cache-enabled**: Smart caching and optimized request patterns to avoid GitHub API limits
- **Search Capabilities**: Find files matching specific patterns within repositories
- **MCP Compatible**: Works with any LLM client supporting the Model Context Protocol
- **Prompt Templates**: Ready-to-use prompt templates for common repository analysis tasks

## Installation

### Global Installation (Recommended for CLI usage)

```bash
npm install -g mcp-github-reader
```

### Local Installation

```bash
npm install mcp-github-reader
```

## Usage

### Running as a Standalone Server

```bash
# If installed globally
mcp-github-reader

# If installed locally
npx mcp-github-reader
```

### Integration with Claude

Add this to your Claude tools configuration:

```json
"github-reader": {
  "command": "mcp-github-reader"
}
```

Or with a full path:

```json
"github-reader": {
  "command": "node",
  "args": ["/path/to/node_modules/mcp-github-reader/src/mcp-github-reader.js"]
}
```

## Available Tools

The MCP server provides four powerful tools for interacting with GitHub repositories:

### 1. get_individual_file_content

Retrieves the content of a specific file from a GitHub repository.

**Parameters:**
- `owner`: Repository owner (e.g., "skydeckai")
- `repo`: Repository name (e.g., "mcp-server-aidd")
- `path`: Path to the file within the repository (e.g., "README.md")
- `branch` (optional): Branch name (defaults to the default branch)

### 2. get_entire_repo_contents

Get an entire repository's content with smart filtering options.

**Parameters:**
- `owner`: Repository owner (e.g., "skydeckai")
- `repo`: Repository name (e.g., "mcp-server-aidd")
- `exclude_patterns` (optional): Patterns to exclude (e.g., ["*.test.js", "node_modules/*"])
- `include_patterns` (optional): Only include files matching these patterns (e.g., ["*.js", "*.json", "*.md"])
- `file_size_limit` (optional): Maximum total size of response (e.g., "5m")
- `individual_file_size_limit` (optional): Skip files larger than this size (e.g., "500k")
- `max_files` (optional): Maximum number of files to include (default: 50)
- `include_contents` (optional): Whether to include file contents or just list files (default: true)
- `use_regex` (optional): Treat exclude/include patterns as regular expressions

### 3. analyzeRepository

Analyzes a repository, providing statistics and language breakdown.

**Parameters:**
- `repository`: Repository name in owner/repo format (e.g., "skydeckai/mcp-server-aidd")
- `includeFiles` (optional): Include file list in analysis (default: false)

### 4. searchRepository

Searches for files matching specific patterns within a repository.

**Parameters:**
- `repository`: Repository name in owner/repo format (e.g., "skydeckai/mcp-server-aidd")
- `query`: Text to search for in filenames (e.g., "function")
- `path` (optional): Filter searches to a specific path (e.g., "src")

## Available Prompts

The server also includes useful prompt templates to help LLMs interact with repositories:

1. `repositoryOverview`: Analyze a repository's purpose and structure
2. `codeExplanation`: Explain code from a specific file
3. `codeSearch`: Search for patterns in a repository
4. `fileContent`: Get content of a specific file
5. `repositoryInfo`: Get repository information
6. `repositoryStructure`: View repository file structure
7. `branchList`: List repository branches

## Examples

### Retrieving individual file content

```json
{
  "name": "get_individual_file_content",
  "parameters": {
    "owner": "skydeckai",
    "repo": "mcp-server-aidd",
    "path": "README.md"
  }
}
```

### Getting repository contents with filtering

```json
{
  "name": "get_entire_repo_contents",
  "parameters": {
    "owner": "skydeckai",
    "repo": "mcp-server-aidd",
    "include_patterns": ["*.js", "*.json", "*.md"],
    "exclude_patterns": ["*.test.js", "node_modules/*"],
    "max_files": 30
  }
}
```

### Analyzing a repository

```json
{
  "name": "analyzeRepository",
  "parameters": {
    "repository": "skydeckai/mcp-server-aidd",
    "includeFiles": true
  }
}
```

## Limitations

- Currently only works with public GitHub repositories
- No support for private repositories or authentication
- Subject to GitHub API rate limits (60 requests per hour for unauthenticated requests)

## License

Apache License 2.0. See LICENSE file for details.

Copyright © 2025 SkyDeck AI Inc.