/**
 * MCP Bridge 测试 — 格式转换单元测试
 */

import { describe, it, expect } from 'vitest';
import {
  mcpToolToOctopiDefinition,
  extractMcpToolResult,
  splitNamespacedToolName,
  MCP_NAMESPACE_SEP,
} from '../../../src/harness/plugin-ecosystem/mcp/bridge.js';
import type { McpToolDefinition, McpToolResult } from '../../../src/core/interfaces/mcp-client.js';

describe('MCP Bridge', () => {
  describe('splitNamespacedToolName', () => {
    it('should split valid namespaced name', () => {
      const result = splitNamespacedToolName('filesystem__read_file');
      expect(result).toEqual({ serverId: 'filesystem', toolName: 'read_file' });
    });

    it('should handle tool names with multiple __', () => {
      const result = splitNamespacedToolName('server__tool__with__sep');
      expect(result).toEqual({ serverId: 'server', toolName: 'tool__with__sep' });
    });

    it('should return null for names without separator', () => {
      expect(splitNamespacedToolName('nonamespace')).toBeNull();
    });

    it('should return null for empty server id', () => {
      expect(splitNamespacedToolName('__toolname')).toBeNull();
    });

    it('should handle separator at end', () => {
      const result = splitNamespacedToolName('server__');
      expect(result).toEqual({ serverId: 'server', toolName: '' });
    });
  });

  describe('mcpToolToOctopiDefinition', () => {
    it('should convert basic MCP tool', () => {
      const mcpTool: McpToolDefinition = {
        name: 'read_file',
        description: 'Read a file from disk',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
          },
          required: ['path'],
        },
      };

      const result = mcpToolToOctopiDefinition(mcpTool, 'fs');

      expect(result.name).toBe('fs__read_file');
      expect(result.description).toBe('Read a file from disk');
      expect(result.parameters.path).toEqual({
        type: 'string',
        description: 'File path',
        required: true,
      });
    });

    it('should handle optional parameters', () => {
      const mcpTool: McpToolDefinition = {
        name: 'search',
        description: 'Search',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results' },
          },
          required: ['query'],
        },
      };

      const result = mcpToolToOctopiDefinition(mcpTool, 'api');

      expect(result.parameters.query.required).toBe(true);
      expect(result.parameters.limit.required).toBe(false);
    });

    it('should handle enum parameters', () => {
      const mcpTool: McpToolDefinition = {
        name: 'format',
        description: 'Format code',
        inputSchema: {
          type: 'object',
          properties: {
            lang: { type: 'string', description: 'Language', enum: ['js', 'ts', 'py'] },
          },
          required: ['lang'],
        },
      };

      const result = mcpToolToOctopiDefinition(mcpTool, 'fmt');

      expect(result.parameters.lang.enum).toEqual(['js', 'ts', 'py']);
    });

    it('should handle empty schema', () => {
      const mcpTool: McpToolDefinition = {
        name: 'ping',
        description: 'Ping server',
        inputSchema: {
          type: 'object',
        },
      };

      const result = mcpToolToOctopiDefinition(mcpTool, 'srv');

      expect(result.name).toBe('srv__ping');
      expect(Object.keys(result.parameters)).toHaveLength(0);
    });

    it('should default missing description', () => {
      const mcpTool: McpToolDefinition = {
        name: 'no-desc',
        inputSchema: { type: 'object' },
      };

      const result = mcpToolToOctopiDefinition(mcpTool, 'srv');

      expect(result.description).toBe('');
    });
  });

  describe('extractMcpToolResult', () => {
    it('should extract single text block', () => {
      const result: McpToolResult = {
        content: [{ type: 'text', text: 'hello world' }],
      };

      expect(extractMcpToolResult(result)).toBe('hello world');
    });

    it('should extract multiple text blocks as array', () => {
      const result: McpToolResult = {
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
      };

      expect(extractMcpToolResult(result)).toEqual(['line 1', 'line 2']);
    });

    it('should handle mixed content types', () => {
      const result: McpToolResult = {
        content: [
          { type: 'text', text: 'some text' },
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
        ],
      };

      const extracted = extractMcpToolResult(result) as Array<{ type: string }>;
      expect(extracted).toHaveLength(2);
      expect(extracted[0]).toEqual({ type: 'text', text: 'some text' });
      expect(extracted[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'base64data' });
    });

    it('should handle empty content', () => {
      const result: McpToolResult = { content: [] };

      expect(extractMcpToolResult(result)).toEqual([]);
    });

    it('should handle resource content', () => {
      const result: McpToolResult = {
        content: [
          {
            type: 'resource',
            resource: { uri: 'file:///test.txt', text: 'file content' },
          },
        ],
      };

      const extracted = extractMcpToolResult(result) as Array<{ type: string; uri: string }>;
      expect(extracted[0].type).toBe('resource');
      expect(extracted[0].uri).toBe('file:///test.txt');
    });

    it('should handle isError result', () => {
      const result: McpToolResult = {
        content: [{ type: 'text', text: 'Tool execution failed' }],
        isError: true,
      };

      // extractMcpToolResult doesn't care about isError, just extracts content
      expect(extractMcpToolResult(result)).toBe('Tool execution failed');
    });
  });
});
