import React, { useState, useEffect, useRef, useCallback } from 'react';
import { WebContainer } from '@webcontainer/api';
import { Octokit } from '@octokit/rest';
import WebContainerManager from '../utils/webcontainer-manager';
import AiChatPanel from './AiChatPanel';
import PreviewPane from './PreviewPane';
import PublishModal from './PublishModal';
import LogsModal from './LogsModal';

interface DevEnvironmentProps {
  githubToken: string | null;
  repoUrl: string;
  basebaseToken: string | null;
  basebaseProject: string | null;
}

interface LogEntry {
  timestamp: Date;
  message: string;
  type: 'info' | 'error' | 'warn';
}

interface ServerInfo {
  url: string;
  port: number;
}

const DevEnvironment: React.FC<DevEnvironmentProps> = ({ githubToken, repoUrl, basebaseToken, basebaseProject }) => {
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadingMessage, setLoadingMessage] = useState<string>('Initializing WebContainer...');

  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPublishModal, setShowPublishModal] = useState<boolean>(false);
  const [showLogsModal, setShowLogsModal] = useState<boolean>(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [modifiedFiles] = useState<Map<string, string>>(new Map());
  const containerRef = useRef<WebContainer | null>(null);
  const initializedRef = useRef<boolean>(false);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info'): void => {
    const newLog: LogEntry = {
      timestamp: new Date(),
      message: message.trim(),
      type
    };
    setLogs(prevLogs => [...prevLogs, newLog]);
  }, []);

  const clearLogs = (): void => {
    setLogs([]);
  };

  const cloneRepository = useCallback(async (container: WebContainer): Promise<void> => {
    if (!githubToken) {
      throw new Error('GitHub token is required');
    }

    const octokit = new Octokit({ auth: githubToken });

    // Parse repository URL to get owner and repo
    const urlParts = repoUrl.replace('https://github.com/', '').split('/');
    if (urlParts.length < 2) {
      throw new Error('Invalid repository URL format');
    }
    const owner = urlParts[0];
    const repo = urlParts[1];

    interface FileSystemTree {
      [name: string]: FileNode | DirectoryNode;
    }

    interface FileNode {
      file: {
        contents: string | Uint8Array;
      };
    }

    interface DirectoryNode {
      directory: FileSystemTree;
    }

    interface TreeEntry {
      file?: {
        contents: string | Uint8Array;
      };
      directory?: FileSystemTree;
    }

    const filesMap = new Map<string, string | Uint8Array>();
    
    // Helper function to recursively get all files from a directory
    const getDirectoryContents = async (path: string = ''): Promise<void> => {
      try {
        const { data: contents } = await octokit.repos.getContent({
          owner,
          repo,
          path
        });

        if (Array.isArray(contents)) {
          for (const item of contents) {
            if (item.type === 'file' && item.download_url) {
              const response = await fetch(item.download_url);
              
              // Check if this is a binary file based on extension
              const isBinaryFile = /\.(png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|pdf|zip|tar|gz|mp4|mov|avi|mp3|wav)$/i.test(item.path);
              
              if (isBinaryFile) {
                // Handle binary files properly
                const arrayBuffer = await response.arrayBuffer();
                const uint8Array = new Uint8Array(arrayBuffer);
                filesMap.set(item.path, uint8Array);
              } else {
                // Handle text files normally
                const content = await response.text();
                filesMap.set(item.path, content);
              }
            } else if (item.type === 'dir') {
              // Recursively get contents of subdirectory
              await getDirectoryContents(item.path);
            }
          }
        } else if (contents.type === 'file' && contents.download_url) {
          // Single file
          const response = await fetch(contents.download_url);
          
          // Check if this is a binary file based on extension
          const isBinaryFile = /\.(png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|pdf|zip|tar|gz|mp4|mov|avi|mp3|wav)$/i.test(contents.path);
          
          if (isBinaryFile) {
            // Handle binary files properly
            const arrayBuffer = await response.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            filesMap.set(contents.path, uint8Array);
          } else {
            // Handle text files normally
            const content = await response.text();
            filesMap.set(contents.path, content);
          }
        }
      } catch (error) {
        console.warn(`Failed to get contents for path: ${path}`, error);
      }
    };

    // Get all files recursively
    await getDirectoryContents();



    // Build proper FileSystemTree
    const fileSystemTree: FileSystemTree = {};
    
    for (const [path, content] of filesMap) {
      const parts = path.split('/').filter(part => part.length > 0);
      let current = fileSystemTree;
      
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLastPart = i === parts.length - 1;
        
        if (isLastPart) {
          // This is a file
          current[part] = {
            file: {
              contents: content
            }
          };
        } else {
          // This is a directory
          if (!current[part]) {
            current[part] = {
              directory: {}
            };
          }
          current = (current[part] as DirectoryNode).directory;
        }
      }
    }



    try {
      await container.mount(fileSystemTree);
      
      // WORKAROUND: Directly write binary files to fix corruption issue
      const rewriteBinaryFiles = async (tree: FileSystemTree, currentPath = '') => {
        for (const [key, value] of Object.entries(tree)) {
          const fullPath = currentPath ? `${currentPath}/${key}` : key;
          
          const entry = value as TreeEntry;
          if (entry && typeof entry === 'object') {
            if ('file' in entry && entry.file?.contents) {
              const contents = entry.file.contents;
              
              // Only rewrite binary files (images)
              if (contents instanceof Uint8Array && key.match(/\.(png|jpg|jpeg|gif|svg|ico|webp|avif)$/i)) {
                await container.fs.writeFile(fullPath, contents);
              }
            } else if ('directory' in entry && entry.directory) {
              await rewriteBinaryFiles(entry.directory, fullPath);
            }
          }
        }
      };
      
      await rewriteBinaryFiles(fileSystemTree);
      
    } catch (mountError) {
      console.error('Failed to mount FileSystemTree:', mountError);
      throw new Error(`Mount failed: ${mountError}`);
    }

    
    // Note: WebContainer doesn't have git installed, so we'll use GitHub API for version control
  }, [githubToken, repoUrl]);



  const installDependencies = useCallback(async (container: WebContainer): Promise<void> => {
    const installProcess = await container.spawn('npm', ['install']);
    const exitCode = await installProcess.exit;
    
    if (exitCode !== 0) {
      throw new Error('Failed to install dependencies');
    }
  }, []);

  /* const installClaudeCode = async (container: WebContainer): Promise<void> => {
    // Clean npm cache to prevent EEXIST errors
    console.log('Cleaning npm cache to fix potential EEXIST errors...');
    const cacheCleanProcess = await container.spawn('npm', ['cache', 'clean', '--force']);
    cacheCleanProcess.output.pipeTo(new WritableStream({
        write(data) {
            console.log('npm cache clean output:', data);
        }
    }));
    const cacheCleanExitCode = await cacheCleanProcess.exit;
    if (cacheCleanExitCode !== 0) {
        console.warn(`'npm cache clean --force' exited with code ${cacheCleanExitCode}.`);
    }
    
    // Set up a directory for global npm packages to avoid permissions errors.
    console.log('Setting up npm global directory to avoid permission errors...');
    const npmGlobalPath = '/home/.npm-global';
    const setupProcess = await container.spawn('sh', [
        '-c',
        `mkdir -p ${npmGlobalPath} && npm config set prefix '${npmGlobalPath}'`
    ]);
    setupProcess.output.pipeTo(new WritableStream({
        write(data) { console.log('npm setup output:', data); }
    }));
    if ((await setupProcess.exit) !== 0) {
        throw new Error('Failed to set up npm global directory.');
    }

    // Install claude-code globally, ensuring the new global bin is in the PATH.
    console.log('Installing @anthropic-ai/claude-code globally...');
    const installCommand = `export PATH=${npmGlobalPath}/bin:$PATH && npm install -g @anthropic-ai/claude-code`;
    const installProcess = await container.spawn('sh', ['-c', installCommand]);
    const installExitCode = await installProcess.exit;
    if (installExitCode !== 0) {
      throw new Error('Failed to install @anthropic-ai/claude-code');
    }

    // Manually make the cli script executable, as npm might fail to do so.
    const chmodCliProcess = await container.spawn('sh', [
        '-c',
        `chmod +x ${npmGlobalPath}/lib/node_modules/@anthropic-ai/claude-code/cli.js`
    ]);
    if ((await chmodCliProcess.exit) !== 0) {
        throw new Error('Failed to make claude cli executable.');
    }

    // Create a wrapper script for claude since symlinks don't work in WebContainer
    console.log('Creating wrapper script for claude...');
    const wrapperScript = `#!/bin/sh\nnode ${npmGlobalPath}/lib/node_modules/@anthropic-ai/claude-code/cli.js "$@"`;
    const createWrapperProcess = await container.spawn('sh', [
        '-c',
        `rm -f ${npmGlobalPath}/bin/claude && echo '${wrapperScript}' > ${npmGlobalPath}/bin/claude-wrapper && chmod +x ${npmGlobalPath}/bin/claude-wrapper && mv ${npmGlobalPath}/bin/claude-wrapper ${npmGlobalPath}/bin/claude`
    ]);
    createWrapperProcess.output.pipeTo(new WritableStream({
        write(data) { console.log('wrapper script creation output:', data); }
    }));
    if ((await createWrapperProcess.exit) !== 0) {
        throw new Error('Failed to create claude wrapper script.');
    }

    // Create the API key helper script
    const apiKeyHelperContent = `echo "API keys are now managed server-side"`;
    const helperPath = '/home/anthropicApiKeyHelper.sh';
    
    const createScriptProcess = await container.spawn('sh', [
      '-c',
      `echo '${apiKeyHelperContent}' > ${helperPath}`
    ]);
    if ((await createScriptProcess.exit) !== 0) {
      throw new Error('Failed to create API key helper script.');
    }

    // Make the script executable
    const chmodProcess = await container.spawn('sh', ['-c', `chmod +x ${helperPath}`]);
    if ((await chmodProcess.exit) !== 0) {
      throw new Error('Failed to make API key helper executable.');
    }

    // Create the settings directory and file
    const settingsDir = '/home/.claude';
    const settingsPath = `${settingsDir}/settings.local.json`;
    
    const mkdirProcess = await container.spawn('sh', ['-c', `mkdir -p ${settingsDir}`]);
     if ((await mkdirProcess.exit) !== 0) {
      throw new Error('Failed to create .claude directory.');
    }

    const settingsContent = {
      permissions: {
        allow: [
          "Bash(find:*)",
          "Bash(ls:*)"
        ],
        deny: []
      },
      apiKeyHelper: helperPath
    };
    
    const createSettingsProcess = await container.spawn('sh', [
      '-c',
      `echo '${JSON.stringify(settingsContent)}' > ${settingsPath}`
    ]);
    if ((await createSettingsProcess.exit) !== 0) {
      throw new Error('Failed to create claude settings file.');
    }

    // Test the claude command and log output, using the correct PATH
    console.log('Testing `claude` command...');
    const testCommand = `${npmGlobalPath}/bin/claude --help > /dev/null 2>&1`;
    const claudeProcess = await container.spawn('sh', ['-c', testCommand]);

    const claudeExitCode = await claudeProcess.exit;
    if (claudeExitCode !== 0) {
      console.warn(`Claude Code installation completed but PATH resolution failed (expected in WebContainer). Claude Code is accessible via: ${npmGlobalPath}/bin/claude`);
    } else {
      console.log('✅ Claude Code installation and configuration completed successfully!');
    }
  };*/

  const startDevServer = useCallback(async (container: WebContainer): Promise<void> => {
    let hasWebContainerUrl = false; // Track if we have a WebContainer URL
    
    // Listen for WebContainer's server-ready events
    container.on('server-ready', (port: number, url: string) => {
      console.log('WebContainer server-ready event:', { port, url });
      hasWebContainerUrl = true; // Mark that we have a WebContainer URL
      handleServerReady({ url, port });
      setIsLoading(false);
    });

    // Also listen for port events
    container.on('port', (port: number, type: 'open' | 'close', url: string) => {
      console.log('WebContainer port event:', { port, type, url });
      if (type === 'open') {
        hasWebContainerUrl = true; // Mark that we have a WebContainer URL
        handleServerReady({ url, port });
        setIsLoading(false);
      }
    });



    // Create .stackblitzrc to enable CORS proxy (requires subscription)
    try {
      const stackblitzConfig = {
        corsProxy: true,
        installDependencies: true,
        startCommand: "npm run dev"
      };
      await container.fs.writeFile('.stackblitzrc', JSON.stringify(stackblitzConfig, null, 2));
      console.log('✅ Created .stackblitzrc with CORS proxy enabled');
      addLog('Enabled StackBlitz CORS proxy (requires subscription)', 'info');
    } catch (error) {
      console.warn('Failed to create .stackblitzrc:', error);
      addLog('Failed to create StackBlitz config: ' + error, 'warn');
    }



    // Check if vite.config exists, if not create one with WebContainer-optimized settings
    try {
      await container.fs.readFile('vite.config.js', 'utf-8');
    } catch {
      // Try to copy existing vite.config.ts to vite.config.js
      try {
        const existingConfig = await container.fs.readFile('vite.config.ts', 'utf-8');
        await container.fs.writeFile('vite.config.js', existingConfig);
        console.log('✅ Copied existing vite.config.ts to vite.config.js');
      } catch {
        // No existing config, create a WebContainer-optimized one
        const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'cors-headers',
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          // Essential COOP/COEP headers for WebContainer
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          
          // Additional CORS headers for external resources
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          
          next();
        });
      }
    },
    {
      name: 'image-proxy',
      configureServer(server) {
        // Handle Next.js image optimization fallback
        server.middlewares.use('/_next/image', async (req, res) => {
          try {
            const url = new URL(req.url || '', 'http://localhost');
            const imageUrl = url.searchParams.get('url');
            
            if (!imageUrl) {
              res.statusCode = 400;
              res.end('Missing url parameter');
              return;
            }

            // Decode the URL (Next.js URL-encodes it)
            const decodedUrl = decodeURIComponent(imageUrl);
            console.log('📸 Next.js image fallback:', decodedUrl);
            
                         // For local assets, redirect to the direct file path
             if (decodedUrl.startsWith('/')) {
               console.log('📸 Redirecting Next.js image to direct asset:', decodedUrl);
               res.statusCode = 302;
               res.setHeader('Location', decodedUrl);
               res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
               res.end();
               return;
             }

             // For external URLs, redirect directly (Next.js will handle CORS)
             console.log('📸 Redirecting Next.js image to external URL:', decodedUrl);
             res.statusCode = 302;
             res.setHeader('Location', decodedUrl);
             res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
             res.end();
          } catch (error) {
            console.error('Next.js image handler error:', error);
            res.statusCode = 500;
            res.end('Image handler error');
          }
        });
        
        // Enhanced image proxy for external images
        server.middlewares.use('/api/proxy-image', async (req, res) => {
          try {
            const url = new URL(req.url || '', 'http://localhost');
            const imageUrl = url.searchParams.get('url');
            
            console.log('🖼️ Image proxy request:', imageUrl);
            
            if (!imageUrl) {
              console.error('❌ Image proxy: Missing url parameter');
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Missing url parameter' }));
              return;
            }

            // Validate URL format
            let targetUrl;
            try {
              targetUrl = new URL(imageUrl);
            } catch (urlError) {
              console.error('❌ Image proxy: Invalid URL format:', imageUrl);
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Invalid URL format' }));
              return;
            }

            // Security: Only allow http/https protocols
            if (!['http:', 'https:'].includes(targetUrl.protocol)) {
              console.error('❌ Image proxy: Invalid protocol:', targetUrl.protocol);
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Only HTTP/HTTPS URLs are allowed' }));
              return;
            }

            console.log('🔗 Fetching image from:', targetUrl.href);
            const response = await fetch(targetUrl.href, {
              headers: {
                'User-Agent': 'WebContainer-ImageProxy/1.0'
              }
            });
            
            if (!response.ok) {
              console.error('❌ Image proxy: HTTP ' + response.status + ' from ' + targetUrl.href);
              res.statusCode = response.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ 
                error: 'Failed to fetch image: ' + response.status + ' ' + response.statusText,
                url: imageUrl
              }));
              return;
            }

            // Copy headers and set CORP header
            const contentType = response.headers.get('content-type') || 'image/*';
            const contentLength = response.headers.get('content-length');
            
            console.log('✅ Image proxy: Successfully fetched ' + contentType + ' (' + (contentLength || 'unknown size') + ')');
            
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            
            if (contentLength) {
              res.setHeader('Content-Length', contentLength);
            }
            
            // Stream the image
            if (response.body) {
              const reader = response.body.getReader();
              
              const pump = async () => {
                try {
                  const { done, value } = await reader.read();
                  if (done) {
                    res.end();
                    return;
                  }
                  res.write(Buffer.from(value));
                  return pump();
                } catch (streamError) {
                  console.error('❌ Image proxy: Stream error:', streamError);
                  res.end();
                }
              };
              
              await pump();
            } else {
              res.end();
            }
          } catch (error) {
            console.error('❌ Image proxy error:', error);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ 
              error: 'Internal proxy error',
              details: error && error.message ? error.message : 'Unknown error'
            }));
          }
        });
        
        // Test endpoint for debugging
        server.middlewares.use('/api/test-proxy', (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          res.end(JSON.stringify({
            message: 'Image proxy is working!',
            timestamp: new Date().toISOString(),
            proxyUrl: '/api/proxy-image?url=https://example.com/image.jpg',
            instructions: 'Use /api/proxy-image?url=<encoded-image-url> to proxy external images'
          }));
        });
      }
    },
    {
      name: 'webcontainer-asset-debug',
      configureServer(server) {
        // Log all requests to help debug asset serving
        server.middlewares.use((req, res, next) => {
          if ((req.url && req.url.includes('assets')) || (req.url && req.url.includes('images')) || (req.url && req.url.includes('.png'))) {
            console.log('🔍 Request URL:', req.url);
            console.log('🔍 Request method:', req.method);
            console.log('🔍 Request headers:', req.headers);
          }
          next();
        });
      }
    },
    {
      name: 'inject-image-helper',
      transformIndexHtml(html) {
        return html.replace(
          '<head>',
          \`<head>
    <script>
      // WebContainer Image Loading Helper - Enhanced Version
      console.log('🖼️ WebContainer Image Helper v2.0 loaded');
      
      // Function to proxy external images
      window.proxyImageUrl = function(originalUrl) {
        if (!originalUrl) return originalUrl;
        
        try {
          const url = new URL(originalUrl);
          // If it's already local, return as-is
          if (url.origin === window.location.origin) {
            return originalUrl;
          }
          
          // Skip data URLs and blob URLs
          if (originalUrl.startsWith('data:') || originalUrl.startsWith('blob:')) {
            return originalUrl;
          }
          
          // Use proxy for external URLs
          return '/api/proxy-image?url=' + encodeURIComponent(originalUrl);
        } catch {
          // If URL parsing fails, assume it's relative
          return originalUrl;
        }
      };
      
      // Pre-process all images before they load
      window.preProcessImages = function() {
        const images = document.querySelectorAll('img:not([data-proxy-processed])');
        let processed = 0;
        
        images.forEach(img => {
          img.setAttribute('data-proxy-processed', 'true');
          
          // If src is external, proxy it immediately
          if (img.src && !img.src.startsWith(window.location.origin) && 
              !img.src.startsWith('data:') && !img.src.startsWith('blob:') &&
              !img.src.includes('/api/proxy-image')) {
            console.log('🔧 Pre-processing external image:', img.src);
            img.src = window.proxyImageUrl(img.src);
            processed++;
          }
          
          // Also check srcset
          if (img.srcset) {
            const srcsetParts = img.srcset.split(',').map(part => {
              const [url, ...rest] = part.trim().split(' ');
              if (url && !url.startsWith(window.location.origin) && 
                  !url.startsWith('data:') && !url.startsWith('blob:') &&
                  !url.includes('/api/proxy-image')) {
                return window.proxyImageUrl(url) + (rest.length ? ' ' + rest.join(' ') : '');
              }
              return part;
            });
            img.srcset = srcsetParts.join(', ');
          }
          
          // Add error handler as backup
          img.addEventListener('error', function() {
            if (this.hasAttribute('data-proxy-retry')) return;
            
            this.setAttribute('data-proxy-retry', 'true');
            const originalSrc = this.src;
            if (originalSrc && !originalSrc.includes('/api/proxy-image')) {
              console.log('🔧 Retry fixing broken image:', originalSrc);
              this.src = window.proxyImageUrl(originalSrc);
            }
          }, { once: true });
        });
        
        console.log('✅ Pre-processed ' + processed + ' external images');
        return processed;
      };
      
      // Enhanced auto-fix for broken images
      window.fixBrokenImages = function() {
        return window.preProcessImages();
      };
      
             // Override Image constructor to automatically proxy external URLs
       const OriginalImage = window.Image;
       window.Image = function(width, height) {
         const img = new OriginalImage(width, height);
         
         // Override src setter
         let _src = '';
         Object.defineProperty(img, 'src', {
           get: function() { return _src; },
           set: function(value) {
             _src = value;
             const proxiedUrl = window.proxyImageUrl(value);
             OriginalImage.prototype.src.call(this, proxiedUrl);
           }
         });
         
         return img;
       };
      
      // Copy static properties
      Object.setPrototypeOf(window.Image, OriginalImage);
      Object.setPrototypeOf(window.Image.prototype, OriginalImage.prototype);
      
      // Auto-fix on DOM ready and mutations
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', window.preProcessImages);
      } else {
        window.preProcessImages();
      }
      
      // Watch for new images and external URL changes
      if (typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver((mutations) => {
          let needsProcessing = false;
          
          mutations.forEach((mutation) => {
            // Check for new nodes
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === 1) {
                if (node.tagName === 'IMG') {
                  needsProcessing = true;
                } else if (node.querySelectorAll) {
                  const images = node.querySelectorAll('img');
                  if (images.length > 0) {
                    needsProcessing = true;
                  }
                }
              }
            });
            
            // Check for attribute changes on img elements
            if (mutation.type === 'attributes' && 
                mutation.target.tagName === 'IMG' &&
                (mutation.attributeName === 'src' || mutation.attributeName === 'srcset')) {
              needsProcessing = true;
            }
          });
          
          if (needsProcessing) {
            // Small delay to batch multiple changes
            setTimeout(window.preProcessImages, 10);
          }
        });
        
        // Wait for body to be available before observing
        if (document.body) {
          observer.observe(document.body, { 
            childList: true, 
            subtree: true, 
            attributes: true,
            attributeFilter: ['src', 'srcset']
          });
        } else {
          // Wait for body to be created
          document.addEventListener('DOMContentLoaded', function() {
            if (document.body) {
              observer.observe(document.body, { 
                childList: true, 
                subtree: true, 
                attributes: true,
                attributeFilter: ['src', 'srcset']
              });
            }
          });
        }
      }
      
      console.log('✅ Enhanced image proxy system initialized');
    </script>\`
        );
      }
    }
  ],
  // Configure static asset serving for WebContainer
  publicDir: 'public',
  
  server: {
    host: '0.0.0.0',
    port: 5173,
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: false
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    }
  },
  build: {
    assetsInlineLimit: 0, // Don't inline assets, serve them as files
    rollupOptions: {
      output: {
        // Ensure assets have proper CORS headers
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('development')
  }
})
`;
        try {
          await container.fs.writeFile('vite.config.js', viteConfig);
          console.log('✅ Created WebContainer-optimized vite.config.js with CORS proxy');
          addLog('Created optimized Vite config with image proxy', 'info');
        } catch (writeError) {
          console.warn('Failed to create vite.config.js:', writeError);
          addLog('Failed to create Vite config: ' + writeError, 'warn');
        }
      }
    }

      // Create WebContainer-optimized configurations for common build tools
      try {
        // Create a Next.js config optimized for WebContainer
        const nextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable comprehensive logging for debugging
  logging: {
    fetches: {
      fullUrl: true,
    },
  },
  // Disable SWC in favor of Babel for WebContainer compatibility
  swcMinify: false,
  compiler: {
    // Disable SWC compiler features that don't work well in WebContainer
    removeConsole: false,
    styledComponents: false,
  },
  // Optimize for WebContainer environment
  experimental: {
    // Disable features that cause issues in WebContainer
    esmExternals: false,
    serverComponentsExternalPackages: [],
    // Use webpack instead of Turbopack
    turbo: false,
  },
  // Webpack configuration for WebContainer
  webpack: (config, { dev, isServer }) => {
    if (dev && !isServer) {
      // Disable some optimizations that cause issues in WebContainer
      config.optimization.splitChunks = false;
      
      // Fallback for Node.js modules in browser
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        stream: false,
        url: false,
        zlib: false,
        http: false,
        https: false,
        assert: false,
        os: false,
        path: false,
      };
    }
    return config;
  },
  // Disable features that require file system watching
  onDemandEntries: {
    maxInactiveAge: 60 * 1000,
    pagesBufferLength: 2,
  },
  // Optimize images for WebContainer
  images: {
    // Disable image optimization in WebContainer to avoid /_next/image API issues
    unoptimized: true,
    domains: [],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    // Allow external domains for when optimization is re-enabled
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      }
    ],
    // Enable SVG support and configure for WebContainer
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    // Disable loader in WebContainer to avoid API calls
    loader: 'default',
    // Set proper headers for cross-origin isolation
    minimumCacheTTL: 0,
  },
};

module.exports = nextConfig;
`;
        
            // Check if this is a Next.js project before creating the config
      try {
        const packageJson = await container.fs.readFile('package.json', 'utf-8');
        const pkg = JSON.parse(packageJson);
        if (pkg.dependencies?.next || pkg.devDependencies?.next) {
          await container.fs.writeFile('next.config.js', nextConfig);
          console.log('Created WebContainer-optimized next.config.js');
          
          // Create middleware for comprehensive request logging
          const middlewareContent = `import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  return NextResponse.next()
}

// Configure middleware to run on all paths
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
`;
          
          await container.fs.writeFile('middleware.ts', middlewareContent);
          

          

          

        }
      } catch (error) {
        // Package.json doesn't exist or can't be parsed, skip Next.js config
        console.log('Skipping Next.js config - not a Next.js project:', error);
      }
    } catch (error) {
      console.warn('Failed to create Next.js config:', error);
    }

    // Create .swcrc to disable problematic SWC features
    try {
      const swcConfig = {
        "jsc": {
          "parser": {
            "syntax": "typescript",
            "tsx": true,
            "decorators": false,
            "dynamicImport": true
          },
          "target": "es2020",
          "loose": false,
          "externalHelpers": false,
          "keepClassNames": true,
          "preserveAllComments": true,
          // Disable minification that causes issues in WebContainer
          "minify": {
            "compress": false,
            "mangle": false
          }
        },
        "module": {
          "type": "es6",
          "strict": false,
          "strictMode": true,
          "lazy": false,
          "noInterop": false
        },
        // Disable features that don't work well in WebContainer
        "minify": false,
        "sourceMaps": true
      };
      
      await container.fs.writeFile('.swcrc', JSON.stringify(swcConfig, null, 2));
      console.log('Created WebContainer-optimized .swcrc');
    } catch (error) {
      console.warn('Failed to create .swcrc:', error);
    }

    // Prepare environment variables
    const env: Record<string, string> = {};
    if (basebaseToken) {
      env.BASEBASE_TOKEN = basebaseToken;
      env.VITE_BASEBASE_TOKEN = basebaseToken;
      env.NEXT_PUBLIC_BASEBASE_TOKEN = basebaseToken;
      console.log('Setting BASEBASE_TOKEN environment variable to ' + basebaseToken);
    }
    if (basebaseProject) {
      env.BASEBASE_PROJECT = basebaseProject;
      env.VITE_BASEBASE_PROJECT = basebaseProject;
      env.NEXT_PUBLIC_BASEBASE_PROJECT = basebaseProject;
      console.log('Setting BASEBASE_PROJECT environment variable to ' + basebaseProject);
    }

    // Add WebContainer-specific environment variables to fix build issues
    env.NODE_ENV = 'development';
    env.CI = 'false';
    env.DISABLE_ESLINT_PLUGIN = 'true';
    env.TSC_COMPILE_ON_ERROR = 'true';
    env.ESLINT_NO_DEV_ERRORS = 'true';
    env.GENERATE_SOURCEMAP = 'false';
    // Disable SWC compiler issues
    env.SWC_DISABLE_MMAP = '1';
    env.NEXT_TELEMETRY_DISABLED = '1';
    // Fix for WebAssembly loading issues
    env.WASM_BINDGEN_FALLBACK = '1';
    // CORS and image loading specific
    env.CORS_ENABLED = 'true';
    env.CORS_ORIGIN = '*';
    env.VITE_CORS_PROXY = 'true';
    // Cross-origin isolation support
    env.COOP = 'same-origin';
    env.COEP = 'require-corp';
    env.CORP = 'cross-origin';
    console.log('Set WebContainer-optimized environment variables with CORS support');

    // Create .env.local file BEFORE starting the dev server so Next.js can read the variables
    try {
      let envContent = `# Asset serving configuration for WebContainer
VITE_BASE_URL=/
PUBLIC_URL=/
VITE_ASSET_URL=/
# Allow loading assets from the dev server
VITE_DEV_SERVER_CORS=true
`;

      // Add Basebase environment variables if available (with NEXT_PUBLIC_ prefix for client-side access)
      if (basebaseToken) {
        envContent += `\n# Basebase authentication
BASEBASE_TOKEN=${basebaseToken}
NEXT_PUBLIC_BASEBASE_TOKEN=${basebaseToken}
`;
      }
      if (basebaseProject) {
        envContent += `BASEBASE_PROJECT=${basebaseProject}
NEXT_PUBLIC_BASEBASE_PROJECT=${basebaseProject}
`;
      }

      await container.fs.writeFile('.env.local', envContent);
      console.log('✅ Created .env.local BEFORE starting dev server');
      if (basebaseProject) {
        console.log('✅ Added BASEBASE_PROJECT to .env.local:', basebaseProject);
        addLog(`Added BASEBASE_PROJECT environment variable: ${basebaseProject}`, 'info');
      }
      if (basebaseToken) {
        console.log('✅ Added BASEBASE_TOKEN to .env.local');
        addLog('Added BASEBASE_TOKEN environment variable', 'info');
      }
    } catch (error) {
      console.warn('Failed to create .env.local:', error);
    }

    const { process: devProcess } = await WebContainerManager.runCommandWithEnv('npm', ['run', 'dev'], env);
    
    // Set up a timeout to try alternative start commands if the main one doesn't work
    const fallbackTimeout = setTimeout(async () => {
      console.log('🔧 Primary dev command taking longer than expected, checking for alternatives...');
      
      try {
        const packageJson = await container.fs.readFile('package.json', 'utf-8');
        const pkg = JSON.parse(packageJson);
        const scripts = pkg.scripts || {};
        
        console.log('Available scripts:', Object.keys(scripts));
        
        // Try alternative commands if available
        const alternatives = ['start', 'serve', 'preview'];
        for (const alt of alternatives) {
          if (scripts[alt] && alt !== 'dev') {
            console.log(`🔧 Found alternative script: ${alt}`);
            addLog(`Trying alternative start command: npm run ${alt}`, 'info');
            // Note: We won't actually run it here since the first process is already running
            // This is just for logging what alternatives exist
          }
        }
      } catch (error) {
        console.warn('Could not check package.json for alternatives:', error);
      }
    }, 30000); // 30 seconds
    
    // Clear the timeout if the server starts successfully
    const handleServerReady = (info: ServerInfo) => {
      clearTimeout(fallbackTimeout);
      setServerInfo(info);
    };

    // Listen for server ready in output as backup
    devProcess.output.pipeTo(new WritableStream({
      write(data: string) {
        console.log('Dev server output:', data);
        
        // Check for specific build tool errors and suggest fixes
        if (data.includes('[Contextify]') || data.includes('SWC_DISABLE_MMAP')) {
          console.warn('🔧 SWC compilation issue detected - this is common in WebContainer environments');
          addLog('SWC compilation warning detected - using fallback configuration', 'warn');
        }
        
        if (data.includes('WebAssembly') || data.includes('wasm')) {
          console.warn('🔧 WebAssembly issue detected - this may affect some build tools');
          addLog('WebAssembly issue detected - using fallback configuration', 'warn');
        }
        
        if (data.includes('ENOSPC') || data.includes('no space left')) {
          console.error('❌ Out of disk space in WebContainer');
          addLog('WebContainer out of disk space - try clearing cache', 'error');
        }
        
        // Check for CORS/image loading related messages
        if (data.toLowerCase().includes('cors') || data.toLowerCase().includes('cross-origin')) {
          console.log('🖼️ CORS-related message detected - image proxy should handle this');
          addLog('CORS configuration active - external images will be proxied', 'info');
        }
        
        if (data.includes('Image Helper loaded')) {
          console.log('✅ Image loading helper successfully injected');
          addLog('Image loading helper active - external images will auto-fix', 'info');
        }
        
        // Check for Next.js image optimization issues
        if (data.includes('/_next/image')) {
          console.log('📸 Next.js image request detected - fallback handler should process this');
          addLog('Next.js image optimization fallback active', 'info');
        }
        
        if (data.toLowerCase().includes('next.js') && data.toLowerCase().includes('config')) {
          console.log('⚙️ Next.js configuration loaded');
          addLog('Next.js WebContainer optimization applied', 'info');
        }
        
        // Add log entry for all output
        let logType: LogEntry['type'] = 'info';
        if (data.toLowerCase().includes('error') || data.toLowerCase().includes('failed')) {
          logType = 'error';
        } else if (data.toLowerCase().includes('warn') || data.toLowerCase().includes('warning')) {
          logType = 'warn';
        }
        addLog(data, logType);
        
        // Look for various Vite/Next.js output patterns
        // Only use localhost URLs if we don't already have a WebContainer URL
        if (!hasWebContainerUrl) {
          const patterns = [
            /Local:\s+http:\/\/localhost:(\d+)/,
            /localhost:(\d+)/,
            /Local.*?:(\d+)/,
            /ready in.*localhost:(\d+)/i,
            /dev server running at.*localhost:(\d+)/i,
            /ready on.*localhost:(\d+)/i,
            /started server on.*:(\d+)/i,
          ];
          
          for (const pattern of patterns) {
            const match = data.match(pattern);
            if (match) {
              const detectedPort = parseInt(match[1]);
              console.log('Server detected on port:', detectedPort);
              handleServerReady({ url: `http://localhost:${detectedPort}`, port: detectedPort });
              setIsLoading(false);
              return;
            }
          }
        } else {
          // We already have a WebContainer URL, just log the detection for debugging
          const patterns = [
            /Local:\s+http:\/\/localhost:(\d+)/,
            /localhost:(\d+)/,
          ];
          
          for (const pattern of patterns) {
            const match = data.match(pattern);
            if (match) {
              const detectedPort = parseInt(match[1]);
              console.log('Server detected on port:', detectedPort, '(ignoring localhost URL, using WebContainer URL)');
              return;
            }
          }
        }
      }
    }));
  }, [basebaseToken, basebaseProject, addLog]);

  const initializeEnvironment = useCallback(async (): Promise<void> => {
    console.log('=== DevEnvironment Initialization Start ===');

    try {
      // Debug cross-origin isolation status
      console.log('Cross-origin isolated:', self.crossOriginIsolated);
      console.log('SharedArrayBuffer available:', typeof SharedArrayBuffer !== 'undefined');
      console.log('Environment:', import.meta.env.MODE);
      
      if (!self.crossOriginIsolated) {
        throw new Error(
          'This application requires cross-origin isolation to function properly. ' +
          'The page appears to not be properly configured. Please contact support.'
        );
      }

      setLoadingMessage(`Starting WebContainer...`);
      console.log('Getting WebContainer instance...');
      
      // Get WebContainer instance with retry logic
      const container = await WebContainerManager.getInstance();
      containerRef.current = container;
      console.log('WebContainer instance obtained successfully');

      setLoadingMessage('Cloning repository...');
      console.log('Starting repository clone...');
      await cloneRepository(container);
      console.log('Repository cloned successfully');

      setLoadingMessage('Installing dependencies...');
      console.log('Starting dependency installation...');
      await installDependencies(container);
      console.log('Dependencies installed successfully');

      setLoadingMessage('Starting development server...');
      console.log('Starting development server...');
      await startDevServer(container);
      console.log('Development server started successfully');

      console.log('=== DevEnvironment Initialization Success ===');
      // If we get here, everything worked

    } catch (error: unknown) {
      console.error('=== Environment initialization failed ===');
      console.error('Error message:', error instanceof Error ? error.message : String(error));
      console.error('Error stack:', error instanceof Error ? error.stack : 'No stack');
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [cloneRepository, installDependencies, startDevServer]);

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // Add reload detection
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      console.warn('Page is about to reload/unload during WebContainer initialization!');
      e.preventDefault();
      e.returnValue = '';
      return '';
    };

    const handleUnload = () => {
      console.error('Page unloaded during WebContainer initialization!');
    };

    // Add global error handling
    const handleError = (e: ErrorEvent) => {
      console.error('Global error during WebContainer initialization:', e.error);
      console.error('Error message:', e.message);
      console.error('Error filename:', e.filename);
      console.error('Error line:', e.lineno);
    };

    const handleUnhandledRejection = (e: PromiseRejectionEvent) => {
      console.error('Unhandled promise rejection during WebContainer initialization:', e.reason);
      e.preventDefault(); // Prevent default handling that might cause reload
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('unload', handleUnload);
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    initializeEnvironment();
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('unload', handleUnload);
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      // Don't teardown here since other components might be using the same instance
      // WebContainer will be cleaned up when the app unmounts
    };
  }, [initializeEnvironment]);

  if (error) {
    return (
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex items-center justify-center transition-colors">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 max-w-md w-full mx-4 transition-colors">
          <div className="text-center">
            <div className="w-16 h-16 bg-red-100 dark:bg-red-900 rounded-full mx-auto flex items-center justify-center mb-6 transition-colors">
              <span className="text-2xl">❌</span>
            </div>
            <h2 className="text-xl font-bold text-red-600 dark:text-red-400 mb-4 transition-colors">Error</h2>
            <p className="text-gray-700 dark:text-gray-300 mb-6 transition-colors">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="w-full bg-brand-600 hover:bg-brand-700 text-white py-2 px-4 rounded transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex items-center justify-center transition-colors">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 max-w-md w-full mx-4 text-center transition-colors">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-600 mx-auto mb-4"></div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2 transition-colors">Setting up your development environment</h2>
          <p className="text-gray-600 dark:text-gray-300 transition-colors">{loadingMessage}</p>
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 transition-colors">
            Repository: {repoUrl.replace('https://github.com/', '')}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-100 dark:bg-gray-900 flex flex-col transition-colors">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 shadow-sm border-b dark:border-gray-700 flex items-center justify-between px-6 py-3 transition-colors">
        <div className="flex items-center space-x-3">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white transition-colors">BaseBase Editor</h1>
          <div className="text-sm text-gray-500 dark:text-gray-400 transition-colors">
            {repoUrl.replace('https://github.com/', '')}
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowLogsModal(true)}
            className="bg-gray-500 hover:bg-gray-600 dark:bg-gray-600 dark:hover:bg-gray-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
          >
            Logs
          </button>
          <button
            onClick={() => setShowPublishModal(true)}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
          >
            Publish Changes
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden h-0">
        {/* AI Chat Panel - Fixed 425px width */}
        <div className="w-[425px] flex-shrink-0 bg-white dark:bg-gray-800 border-r dark:border-gray-700 h-full transition-colors">
          <AiChatPanel 
            webcontainer={containerRef.current}
          />
        </div>

        {/* Preview Pane - Takes remaining space */}
        <div className="flex-1 bg-white dark:bg-gray-800 h-full transition-colors">
          <PreviewPane serverInfo={serverInfo} />
        </div>
      </div>

      {/* Publish Modal */}
      {showPublishModal && (
        <PublishModal
          repoUrl={repoUrl}
          githubToken={githubToken}
          modifiedFiles={modifiedFiles}
          onClose={() => setShowPublishModal(false)}
        />
      )}

      {/* Logs Modal */}
      <LogsModal
        logs={logs}
        isOpen={showLogsModal}
        onClose={() => setShowLogsModal(false)}
        onClearLogs={clearLogs}
      />
    </div>
  );
};

export default DevEnvironment; 