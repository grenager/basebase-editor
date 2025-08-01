import React, { useRef, useEffect, useState, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

interface FileNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: FileNode[];
  content?: string;
}

interface CodeEditorProps {
  file: FileNode | null;
  onFileUpdate: (path: string, content: string) => void;
}

const CodeEditor: React.FC<CodeEditorProps> = ({ file, onFileUpdate }) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [editorValue, setEditorValue] = useState<string>('');
  const updateTimeoutRef = useRef<number | null>(null);
  const currentFilePathRef = useRef<string | null>(null);

  const getLanguage = (fileName: string): string => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'ts':
      case 'tsx':
        return 'typescript';
      case 'js':
      case 'jsx':
        return 'javascript';
      case 'json':
        return 'json';
      case 'css':
        return 'css';
      case 'html':
        return 'html';
      case 'md':
        return 'markdown';
      default:
        return 'plaintext';
    }
  };

  const handleEditorDidMount = (editor: editor.IStandaloneCodeEditor): void => {
    editorRef.current = editor;
  };

  const handleBeforeMount = (monaco: typeof import('monaco-editor')): void => {
    // Disable validation/linting for TypeScript and JavaScript
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });

    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });
  };

  const debouncedUpdate = useCallback((path: string, content: string) => {
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
    }
    updateTimeoutRef.current = window.setTimeout(() => {
      onFileUpdate(path, content);
    }, 500); // 500ms debounce
  }, [onFileUpdate]);

  const handleEditorChange = (value: string | undefined): void => {
    if (file && value !== undefined) {
      setEditorValue(value);
      debouncedUpdate(file.path, value);
    }
  };

  useEffect(() => {
    // Only update editor when switching to a different file
    if (file && file.path !== currentFilePathRef.current) {
      currentFilePathRef.current = file.path;
      setEditorValue(file.content || '');
    }
  }, [file]); // React to any file change

  useEffect(() => {
    // Cleanup timeout on unmount
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="bg-gray-50 px-4 py-2 border-b flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">
          {file ? file.name : 'No file selected'}
        </h3>
        {file && (
          <span className="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded">
            {getLanguage(file.name)}
          </span>
        )}
      </div>
      
      <div className="flex-1">
        {file ? (
          <Editor
            height="100%"
            language={getLanguage(file.name)}
            value={editorValue}
            beforeMount={handleBeforeMount}
            onMount={handleEditorDidMount}
            onChange={handleEditorChange}
            theme="vs-light"
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              lineNumbers: 'on',
              roundedSelection: false,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              insertSpaces: true,
              wordWrap: 'on',
            }}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-gray-500">
            <div className="text-center">
              <div className="text-4xl mb-4">📝</div>
              <p>Select a file from the explorer to start editing</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CodeEditor; 